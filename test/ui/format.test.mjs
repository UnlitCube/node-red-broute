// ui/format.js と ui/chart-util.js の純関数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatNumber,
  formatPower,
  formatAmps,
  formatKwh,
  formatRelative,
  formatDuration,
  formatInterval,
  formatDateTime,
  formatTime,
  stampForFile,
  normEpc,
  formatEpc,
  epcName,
  parseEpcList,
  healthTone,
  healthLabel,
  phaseStep,
  txSeconds,
  text,
  formatBy,
  formatEnergy,
} from '../../ui/format.js'
import { niceTicks, tickDigits, extent, segments, gapThreshold, timeTicks, nearestIndex, linePath, areaPath, recordedSince, tipTextWidth, tipLeft } from '../../ui/chart-util.js'
import { S } from '../../ui/strings.js'

const MINUS = '−'

test('formatNumber: 3 桁区切り・負号は U+2212・丸めて 0 なら符号なし・値が無ければ -', () => {
  assert.equal(formatNumber(1234), '1,234')
  assert.equal(formatNumber(-1234), MINUS + '1,234')
  assert.equal(formatNumber(1234.567, 1), '1,234.6')
  assert.equal(formatNumber(5, 1, 1), '5.0')
  assert.equal(formatNumber(-0.04, 0), '0')
  assert.equal(formatNumber(null), '-')
  assert.equal(formatNumber(undefined), '-')
  assert.equal(formatNumber(NaN), '-')
  assert.equal(formatNumber('12'), '-')
})

test('formatPower: 逆潮流は「売電 −1,234 W」', () => {
  const ex = formatPower(-1234)
  assert.equal(ex.full, `売電 ${MINUS}1,234 W`)
  assert.equal(ex.exporting, true)
  assert.equal(ex.label, '売電')
  const im = formatPower(560)
  assert.equal(im.full, '560 W')
  assert.equal(im.exporting, false)
  assert.equal(im.label, null)
  assert.equal(formatPower(0).full, '0 W')
  assert.equal(formatPower(null).full, '-')
  assert.equal(formatPower(null).unit, '')
})

test('formatAmps / formatKwh', () => {
  assert.equal(formatAmps(12.34), '12.3 A')
  assert.equal(formatAmps(5), '5.0 A')
  assert.equal(formatAmps(undefined), '-')
  assert.equal(formatKwh(12345.678), '12,345.678 kWh')
  assert.equal(formatKwh(1.55, 1), '1.6 kWh')
  assert.equal(formatKwh(null), '-')
})

test('formatRelative: 秒・分・時間・日、過去と未来', () => {
  const now = 1_800_000_000_000
  assert.equal(formatRelative(now - 2000, now), 'たった今')
  assert.equal(formatRelative(now - 12000, now), '12 秒前')
  assert.equal(formatRelative(now - 3 * 60e3, now), '3 分前')
  assert.equal(formatRelative(now - 2 * 3600e3, now), '2 時間前')
  assert.equal(formatRelative(now - 47 * 3600e3, now), '47 時間前')
  assert.equal(formatRelative(now - 3 * 86400e3, now), '3 日前')
  assert.equal(formatRelative(now + 90e3, now), '1 分後')
  assert.equal(formatRelative(now + 30e3, now), '30 秒後')
  assert.equal(formatRelative(null, now), '-')
})

test('formatDuration / formatInterval', () => {
  assert.equal(formatDuration(45), '45 秒')
  assert.equal(formatDuration(120), '2 分')
  assert.equal(formatDuration(200), '3 分 20 秒')
  assert.equal(formatDuration(7500), '2 時間 5 分')
  assert.equal(formatDuration(90000), '1 日 1 時間')
  assert.equal(formatDuration(-1), '-')
  assert.equal(formatInterval(15), '15 秒')
  assert.equal(formatInterval(60), '1 分')
  assert.equal(formatInterval(300), '5 分')
  assert.equal(formatInterval(3600), '1 時間')
  assert.equal(formatInterval(90), '90 秒')
  assert.equal(formatInterval(null), '-')
})

test('日時は端末の時刻で、ゼロ詰め', () => {
  const at = new Date(2026, 10, 5, 9, 3, 7).getTime()
  assert.equal(formatDateTime(at), '2026/11/05 09:03:07')
  assert.equal(formatTime(at), '09:03:07')
  assert.equal(stampForFile(at), '20261105-090307')
  assert.equal(formatDateTime(null), '-')
})

test('EPC の正規化と名前', () => {
  assert.equal(normEpc('0xE7'), 'E7')
  assert.equal(normEpc('e7'), 'E7')
  assert.equal(normEpc(0xe7), 'E7')
  assert.equal(normEpc('7'), '07')
  assert.equal(normEpc(' 0x9f '), '9F')
  assert.equal(normEpc('XYZ'), null)
  assert.equal(normEpc('0x123'), null)
  assert.equal(normEpc(256), null)
  assert.equal(normEpc(1.5), null)
  assert.equal(normEpc(null), null)
  assert.equal(formatEpc('0xe8'), 'E8')
  assert.equal(formatEpc('??'), '??')
  assert.equal(epcName('0xE7'), '瞬時電力')
  assert.equal(epcName('FF'), '')
})

test('parseEpcList: 区切り・重複・禁止・個数', () => {
  assert.deepEqual(parseEpcList('E7, 0xe8 E7'), { epcs: ['E7', 'E8'], error: null })
  assert.deepEqual(parseEpcList('E7、E8').epcs, ['E7', 'E8'])
  assert.match(parseEpcList('E7 E2').error, /E2 は送れません/)
  assert.equal(parseEpcList('').error, S.settings.epcTooFew)
  assert.equal(parseEpcList('E7 E8 E0 E3 EA EB 80').error, S.settings.epcTooMany)
  assert.match(parseEpcList('ZZ E7').error, /ZZ/)
})

test('健康の色調・名前、接続の段、送信積算、テキスト', () => {
  assert.deepEqual(
    ['ok', 'busy', 'stale', 'bad', 'stopped', 'idle', 'disabled', 'x'].map(healthTone),
    ['ok', 'warn', 'stale', 'danger', 'info', 'neutral', 'neutral', 'neutral'],
  )
  assert.equal(healthLabel('stopped'), '外部の指示で停止中')
  assert.equal(healthLabel('nope'), '不明')
  assert.equal(phaseStep('opening'), 0)
  assert.equal(phaseStep('configuring'), 1)
  assert.equal(phaseStep('scanning'), 2)
  assert.equal(phaseStep('reauth'), 3)
  assert.equal(phaseStep('verifying'), 4)
  assert.equal(phaseStep('connected'), 5)
  assert.equal(phaseStep('idle'), -1)
  assert.equal(phaseStep('overridden'), -1)
  assert.equal(txSeconds(123456), 123)
  assert.equal(txSeconds(null), null)
  assert.equal(text(''), '-')
  assert.equal(text(0), '0')
  assert.equal(text('<b>x</b>'), '<b>x</b>')
})

// 0.25 刻みが 0.3・0.8 と書かれ、最大 0.1 では 0 0 0.1 0.1 0.1 と同じ数が並んでいた。
// 戻すと落ちるもの: charts.js の目盛りを小数 1 桁へ戻す・tickDigits が刻みでなく値の大きさで決める
test('tickDigits: 目盛りの数は刻みが読める桁で書く（丸めで位置と違う数にしない）', () => {
  const labels = (max) => {
    const t = niceTicks(0, max, 4)
    return t.map((v) => formatNumber(v, tickDigits(t)))
  }
  assert.deepEqual(labels(1), ['0', '0.25', '0.5', '0.75', '1'])
  assert.deepEqual(labels(0.1), ['0', '0.025', '0.05', '0.075', '0.1'])
  assert.deepEqual(labels(0.2), ['0', '0.05', '0.1', '0.15', '0.2'])
  assert.deepEqual(labels(10), ['0', '2.5', '5', '7.5', '10'])
  assert.deepEqual(labels(100), ['0', '25', '50', '75', '100'])
  assert.deepEqual(labels(4000), ['0', '1,000', '2,000', '3,000', '4,000'])
  for (const max of [0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 30, 100, 300, 1000, 5000]) {
    const l = labels(max)
    assert.equal(new Set(l).size, l.length, max + ': ' + l.join(' '))
  }
  assert.equal(tickDigits([1]), 0)
  assert.equal(tickDigits([]), 0)
})

// 値の吹き出しに左端の丸めが無く、スマートフォンの幅で左へ切れていた。
// 戻すと落ちるもの: tipLeft の丸めを外す・右へ回す条件を外す
test('tipLeft: カーソルの右に出し、入らなければ左へ回す。どちらでも描ける範囲からはみ出さない', () => {
  const [left, right] = [60, 346]
  assert.equal(tipLeft(100, 100, left, right), 112, '右に入る')
  assert.equal(tipLeft(300, 100, left, right), 188, '左へ回す')
  assert.equal(tipLeft(150, 234, left, right), 60, '左へ回すと切れるなら左端へ丸める')
  assert.equal(tipLeft(250, 234, left, right), 60)
  for (let x = left; x <= right; x += 7) {
    for (const w of [80, 160, 234, 286]) {
      const t = tipLeft(x, w, left, right)
      assert.ok(t >= left && t + w <= right, x + ' ' + w + ' → ' + t)
    }
  }
})

test('tipTextWidth: 全角と半角で幅を見積もる（文字数の掛け算では、箱が文字の 1.6 倍まで広がった）', () => {
  assert.equal(tipTextWidth('ab'), 13)
  assert.equal(tipTextWidth('計測'), 23)
  assert.equal(tipTextWidth('LQI 計測'), 49)
  assert.equal(tipTextWidth(''), 0)
})

// 動いている Node-RED に追加した台では、起動の時刻の前提が成り立たない。
// 戻すと落ちるもの: recordedSince が recordingSince を見ない・無いときに NaN になる（稼働中の台の先頭の途切れが消える）
test('recordedSince: 起動のあとに動き始めた台はその時刻。無いサーバーは起動の時刻', () => {
  assert.equal(recordedSince(1000, 5000), 5000)
  assert.equal(recordedSince(5000, 1000), 5000, '再起動の前の値は使わない')
  assert.equal(recordedSince(1000, null), 1000)
  assert.equal(recordedSince(1000, undefined), 1000)
  assert.equal(recordedSince(undefined, 5000), undefined, '起動が分からない間は分からないままにする')
})

test('niceTicks: きりのよい目盛り・0 を含む・幅が 0 でも 2 本以上', () => {
  assert.deepEqual(niceTicks(0, 1234, 4), [0, 500, 1000, 1500])
  assert.deepEqual(niceTicks(-300, 1200, 4), [-500, 0, 500, 1000, 1500])
  assert.deepEqual(niceTicks(5, 5, 4), [2, 4, 6, 8])
  assert.ok(niceTicks(0, 0, 4).length >= 2)
  assert.deepEqual(niceTicks(0, 0.3, 3), [0, 0.1, 0.2, 0.3])
  assert.deepEqual(niceTicks(null, 1), [])
})

test('extent / segments / gapThreshold: 途切れと null で線を切る', () => {
  assert.deepEqual(extent([[[1, 5], [2, -3], [3, null]], [[1, 9]]]), [-3, 9])
  assert.equal(extent([[], [[1, null]]]), null)
  const pts = [[0, 1], [30e3, 2], [60e3, null], [90e3, 3], [120e3, 4], [600e3, 5]]
  const segs = segments(pts, 120e3)
  assert.deepEqual(segs, [[[0, 1], [30e3, 2]], [[90e3, 3], [120e3, 4]], [[600e3, 5]]])
  assert.equal(gapThreshold([[0, 1], [30e3, 1], [60e3, 1]]), 120e3)
  assert.equal(gapThreshold([[0, 1], [300e3, 1], [600e3, 1]]), 1200e3)
})

test('timeTicks: ローカル時刻のきりのよい分に揃える', () => {
  const from = new Date(2026, 10, 5, 10, 7, 0).getTime()
  const to = new Date(2026, 10, 5, 11, 7, 0).getTime()
  const ticks = timeTicks(from, to, 6)
  assert.equal(ticks.length, 6)
  assert.deepEqual(
    ticks.map((t) => new Date(t).getMinutes()),
    [10, 20, 30, 40, 50, 0],
  )
  assert.deepEqual(timeTicks(to, from, 6), [])
})

test('nearestIndex / linePath / areaPath', () => {
  const pts = [[0, 1], [10, 2], [20, 3]]
  assert.equal(nearestIndex(pts, -5), 0)
  assert.equal(nearestIndex(pts, 4), 0)
  assert.equal(nearestIndex(pts, 6), 1)
  assert.equal(nearestIndex(pts, 99), 2)
  assert.equal(nearestIndex([], 1), -1)
  const x = (t) => t
  const y = (v) => 10 - v
  assert.equal(linePath(pts, x, y), 'M0.0 9.0L10.0 8.0L20.0 7.0')
  assert.equal(areaPath(pts, x, y, 10), 'M0.0 10.0L0.0 9.0L10.0 8.0L20.0 7.0L20.0 10.0Z')
})

// 変えた人は人の名前ではなく経路。画面は「画面」、フローは「フロー（<ノード名>）」。
// 戻すと落ちるもの: by をそのまま出す（web-ui・flow:取得 が生で出る）。
test('formatBy: web-ui は「画面」、flow:<名前> は「フロー（<名前>）」、無ければ null、知らない値はそのまま', () => {
  assert.equal(formatBy('web-ui'), '画面')
  assert.equal(formatBy('flow:取得の上書き'), 'フロー（取得の上書き）')
  assert.equal(formatBy('flow:'), 'フロー（' + S.unknown + '）')
  assert.equal(formatBy('editor'), 'エディタ')
  assert.equal(formatBy(null), null)
  assert.equal(formatBy(''), null)
  assert.equal(formatBy('dev'), 'dev', '前の版の settings.json に残ったユーザー名')
})

test('formatEnergy: 計測値の行（kWh）を桁区切りで。数値でなければ display、行が無ければ -', () => {
  assert.equal(formatEnergy({ epc: '0xE0', value: 61532, unit: 'kWh', display: '61532 kWh' }), '61,532 kWh')
  assert.equal(formatEnergy({ epc: '0xE3', value: 0.4, unit: 'kWh', display: '0.4 kWh' }), '0.4 kWh')
  assert.equal(formatEnergy({ epc: '0xE0', value: null, display: '' }), S.none)
  assert.equal(formatEnergy({ epc: '0xE0', value: 'x', display: '不明' }), '不明')
  assert.equal(formatEnergy(null), S.none)
})
