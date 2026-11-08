'use strict'

// ============================================================================
//  受信した ECHONET プロパティを、正規化した JSON に直す
// ============================================================================
//
//  EPC は 16 進の番号なので、そのまま下流へ流すと
//  「0xE7 って何だっけ」を毎回引くことになる。
//  保存先 (DB / MQTT / CSV) のスキーマも EPC 番号では決めにくい。
//
//  そこで安定した英語キーに寄せる。EPC 番号も残すので、
//  仕様に当たりたくなったときは追える。
//
//  1 回の取得につき 1 メッセージ。まとめて 1 つの JSON にする。

/** EPC → 正規化キー と、値の取り出し方。 */
const MAP = {
  0x80: { key: 'operationStatus', pick: (v) => ({ value: v.value === 0x30, text: v.display }) },
  0x81: { key: 'installationLocation', pick: (v) => ({ raw: v.raw }) },
  0x82: { key: 'standardVersion', pick: (v) => ({ value: v.display }) },
  0x88: { key: 'faultStatus', pick: (v) => ({ fault: v.value === 0x41, text: v.display }) },
  0x8a: { key: 'manufacturerCode', pick: (v) => ({ value: v.value }) },
  0x8d: { key: 'serialNumber', pick: (v) => ({ value: String(v.value || '').trim() }) },
  0x97: { key: 'meterTime', pick: (v) => ({ value: v.value }) },
  0x98: { key: 'meterDate', pick: (v) => ({ value: v.value }) },
  0x9d: { key: 'announcePropertyMap', pick: (v) => ({ epcs: hexList(v.value) }) },
  0x9e: { key: 'setPropertyMap', pick: (v) => ({ epcs: hexList(v.value) }) },
  0x9f: { key: 'getPropertyMap', pick: (v) => ({ epcs: hexList(v.value) }) },
  0xd3: { key: 'coefficient', pick: (v) => ({ value: v.value }) },
  0xd7: { key: 'cumulativeDigits', pick: (v) => ({ value: v.value, unit: '桁' }) },
  0xe0: { key: 'cumulativeForward', pick: (v) => ({ value: v.value, unit: 'kWh', raw: v.rawCount }) },
  0xe1: { key: 'cumulativeUnit', pick: (v) => ({ value: v.value, unit: 'kWh/count' }) },
  0xe2: { key: 'historyForward', pick: (v) => ({ day: v.collectDay, values: v.value, unit: 'kWh', converted: v.converted }) },
  0xe3: { key: 'cumulativeReverse', pick: (v) => ({ value: v.value, unit: 'kWh', raw: v.rawCount }) },
  0xe4: { key: 'historyReverse', pick: (v) => ({ day: v.collectDay, values: v.value, unit: 'kWh', converted: v.converted }) },
  0xe5: { key: 'historyCollectDay', pick: (v) => ({ value: v.value, unit: '日前' }) },
  0xe7: { key: 'instantPower', pick: (v) => ({ value: v.value, unit: 'W' }) },
  0xe8: {
    key: 'instantCurrent',
    pick: (v) => ({
      r: v.value ? v.value.r : null,
      t: v.value ? v.value.t : null,
      total: v.total === undefined ? null : v.total,
      unit: 'A',
      // 単相 2 線式のメーターは T 相にオーバーフロー値を返す。
      // その場合 t は null になるので、配線方式の手がかりになる。
      wiring: v.value && v.value.t === null ? '単相 2 線' : null,
    }),
  },
  0xea: { key: 'scheduledCumulativeForward', pick: (v) => ({ value: v.value, unit: 'kWh', at: v.timestamp }) },
  0xeb: { key: 'scheduledCumulativeReverse', pick: (v) => ({ value: v.value, unit: 'kWh', at: v.timestamp }) },
  0xec: { key: 'historyForwardReverse', pick: (v) => ({ raw: v.raw }) },
  0xed: { key: 'historyCollectDateTime', pick: (v) => ({ value: v.value }) },
}

function hexList(list) {
  if (!Array.isArray(list)) return []
  return list.map(pad2)
}

function pad2(n) {
  return ('0' + (n & 0xff).toString(16).toUpperCase()).slice(-2)
}

/** ローカル時刻のまま ISO 8601 (オフセット付き) にする。 */
function isoLocal(ms) {
  const d = new Date(ms)
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const p = (n) => String(Math.abs(n)).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(tz / 60)}:${p(tz % 60)}`
  )
}

/**
 * 1 回の取得結果を正規化した JSON に直す。
 *
 * @param {object} result   Sequencer の 'measurement' イベントの中身
 * @param {object} context  { role, deviceKey, port, meter, calibration }
 * @returns {object}
 */
function normalize(result, context) {
  const ctx = context || {}
  const values = {}
  const unknown = []

  for (const v of result.values || []) {
    const m = MAP[v.epc]
    if (!m) {
      unknown.push({ epc: pad2(v.epc), raw: v.raw, display: v.display })
      continue
    }
    const body = m.pick(v)
    body.epc = pad2(v.epc)
    body.name = v.name
    body.display = v.display
    if (v.note) body.note = v.note
    values[m.key] = body
  }

  const out = {
    device: ctx.role || ctx.deviceKey || null,
    deviceKey: ctx.deviceKey || null,
    port: ctx.port || null,
    ts: isoLocal(result.ts || Date.now()),
    esv: result.esv,
    values,
  }

  if (ctx.meter) {
    out.meter = {
      panId: ctx.meter.panid || null,
      channel: ctx.meter.channel === undefined ? null : ctx.meter.channel,
      channelMHz: ctx.meter.channelMHz === undefined ? null : ctx.meter.channelMHz,
      mac: ctx.meter.addr || null,
      ipv6: ctx.meter.ipv6 || null,
      lqi: ctx.meter.lqi === undefined ? null : ctx.meter.lqi,
    }
  }
  if (ctx.calibration && ctx.calibration.coefficient !== null && ctx.calibration.coefficient !== undefined) {
    out.calibration = {
      coefficient: ctx.calibration.coefficient,
      unitFactor: ctx.calibration.unitFactor,
      digits: ctx.calibration.digits === undefined ? null : ctx.calibration.digits,
    }
  }
  // 読み出しを拒否されたプロパティがあったことを残す
  if (result.isGetSna) out.partial = true
  if (unknown.length) out.unknown = unknown

  // --- いま分かっている全部 ------------------------------------------------
  //
  // 階層取得では、1 通に含まれるのは「そのとき要求した EPC」だけ。
  // 瞬時電力は 30 秒ごと、積算は 5 分ごと、製造番号は接続時に 1 回。
  // values だけを見ると「積算が消えた」ように見えてしまうので、
  // これまでに取れた全部を all として添える (取得時刻つき)。
  //
  // Grafana などへ流すときは all を使うと、どの時点でも全項目が揃う。
  if (result.known && typeof result.known === 'object') {
    const all = {}
    for (const [epcHex, v] of Object.entries(result.known)) {
      const epc = parseInt(String(epcHex).replace(/^0x/i, ''), 16)
      const m = MAP[epc]
      if (!m) continue
      const body = m.pick(v)
      body.epc = pad2(epc)
      body.name = v.name
      body.display = v.display
      body.at = isoLocal(v.at || result.ts || Date.now())
      body.fresh = Object.prototype.hasOwnProperty.call(values, m.key)
      all[m.key] = body
    }
    if (Object.keys(all).length) out.all = all
  }

  return out
}

module.exports = { normalize, isoLocal, MAP }
