'use strict'

// ============================================================================
//  画面（HTTP API）とフロー（wsuha-broute の出力 2 の error）で共有する失敗の形
// ============================================================================
//
//  status（HTTP の状態）・code（API の code）・日本語の message・details（項目ごとの理由）。
//  画面はそれを HTTP の状態と {error:{code, message}} にし、フローは出力 2 の error にする。
//
//  service.js から切り出した（預かりの待ち行列 lib/runtime/pending.js は registry が持つので、
//  service を読むと registry → pending → service → registry の輪になる）。service.js は同じものを出し直す。
//
//  ここは Node-RED に依存しない。

class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message 日本語。画面はそのまま出してよい（秘密を入れない）
   * @param {object} [details] 項目ごとの理由
   * @param {object} [headers] HTTP の応答に足すヘッダ（Retry-After など）
   */
  constructor(status, code, message, details, headers) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.headers = headers
  }
}

module.exports = { ApiError }
