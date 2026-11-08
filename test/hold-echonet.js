'use strict'

// 試験用: シミュレーターの ECHONET の応答（ERXUDP の行）を預かり、試験が決めた時に出す。
//
// 「応答は待ちが切れたあとに届く」「取得の途中に押す」のような順を、応答の遅れ（echonetDelayMs）と
// 待ちの長さの差で作ると、並列で流して CPU が足りないときに順が入れ替わる。待ちの張り始めがイベントループの遅れで
// 後ろへずれると、遅れたはずの応答が待ちの切れる前に届き、守りたい分岐を通らないまま緑や赤になる。
// 預かれば、届く順は試験の手の中にある（届けるのは預かってから。遅れの長さには頼らない）。
//
//   const hold = holdEchonet(transport)   // 以後の ERXUDP を預かる
//   await waitFor(() => hold.count === 2) // 送り直しの分まで預かった
//   hold.release(0)                       // 1 本目を届ける（シミュレーターの出す順の箱に 1ms 後で入れる）
//   hold.releaseAll()                     // 預かるのをやめ、残りを預かった順に届ける
//   hold.stop()                           // 預かるのをやめる（預かったままの分は捨てる）

/** 行（文字列か Buffer）が ERXUDP か。 */
function isErxudp(x) {
  const head = Buffer.isBuffer(x) ? x.toString('latin1', 0, 7) : String(x).slice(0, 7)
  return head === 'ERXUDP '
}

function holdEchonet(transport) {
  const held = []
  const emitLine = transport._emitLine
  const emitRaw = transport._emitRaw
  let holding = true

  transport._emitLine = function (text, delayMs) {
    if (holding && isErxudp(text)) {
      held.push({ released: false, send: () => emitLine.call(transport, text, 1) })
      return
    }
    return emitLine.call(this, text, delayMs)
  }
  transport._emitRaw = function (buf, delayMs) {
    if (holding && isErxudp(buf)) {
      held.push({ released: false, send: () => emitRaw.call(transport, buf, 1) })
      return
    }
    return emitRaw.call(this, buf, delayMs)
  }

  return {
    /** 預かった本数（届けた分も数える）。 */
    get count() {
      return held.length
    },
    /** i 本目（0 から）を届ける。同じものを 2 度は届けない。 */
    release(i) {
      const h = held[i]
      if (!h) throw new Error(`預かった応答は ${held.length} 本で、${i + 1} 本目はありません`)
      if (h.released) throw new Error(`${i + 1} 本目はもう届けました`)
      h.released = true
      h.send()
    },
    /** 預かるのをやめて、元の出し方に戻す（預かったままの分は届けない）。 */
    stop() {
      holding = false
      transport._emitLine = emitLine
      transport._emitRaw = emitRaw
    },
    /** 預かるのをやめ、まだ届けていない分を預かった順に届ける。 */
    releaseAll() {
      this.stop()
      for (const h of held) {
        if (h.released) continue
        h.released = true
        h.send()
      }
    },
  }
}

module.exports = { holdEchonet }
