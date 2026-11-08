'use strict'

// ============================================================================
//  受信バイト列を「行」に切る
// ============================================================================
//
//  区切りは CR (0x0D)。LF ではない。
//
//  SKSTACK の応答は <CRLF>本文<CRLF> の形で返るが、
//  プロダクト設定コマンド (WOPT / ROPT / WUART / RUART) の応答は
//  CR 終端で LF が付かない (ROHM BP35C0 コマンドマニュアル 3 章のフォーマットの節)。
//  LF で切ると、この系統の応答が永久に行として確定しない。
//
//  CR で切れば、CRLF 終端の行は CR で切れて次の行頭に LF が残るだけ。
//  その LF は呼び出し側で落とす。

const CR = 0x0d

class LineSplitter {
  constructor(options) {
    const o = options || {}
    this.delimiter = o.delimiter === undefined ? CR : o.delimiter
    // 1 行の上限。これを超えたら区切り文字が来ていないとみなして捨てる。
    // 区切りが来ない状態で溜め続けると、メモリを際限なく使う。
    this.maxLineLength = o.maxLineLength || 65536
    this._buffer = Buffer.alloc(0)
    this.onOverflow = o.onOverflow || null
  }

  /**
   * バイト列を食わせて、確定した行を返す。
   * @param {Buffer} chunk
   * @returns {Buffer[]} 区切り文字を含まない行 (0 個以上)
   */
  push(chunk) {
    if (!chunk || !chunk.length) return []
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : Buffer.from(chunk)

    const lines = []
    let start = 0
    let idx
    while ((idx = this._buffer.indexOf(this.delimiter, start)) !== -1) {
      lines.push(this._buffer.slice(start, idx))
      start = idx + 1
    }
    this._buffer = this._buffer.slice(start)

    if (this._buffer.length > this.maxLineLength) {
      const dropped = this._buffer.length
      this._buffer = Buffer.alloc(0)
      if (this.onOverflow) this.onOverflow(dropped)
    }
    return lines
  }

  /** 溜まっている分を強制的に 1 行として取り出す。 */
  flush() {
    if (!this._buffer.length) return null
    const line = this._buffer
    this._buffer = Buffer.alloc(0)
    return line
  }

  reset() {
    this._buffer = Buffer.alloc(0)
  }
}

module.exports = { LineSplitter, CR }
