// 初回描画の前にテーマを当てる（モジュールではなく同期の普通のスクリプト）。
// 保存の値が無い・読めないときは何もしない。tokens.css が OS の設定に合わせる。
// 保存キーと値は ui/app.js の THEME_KEY と同じ（test/ui/tokens.test.mjs が照合する）。
;(function () {
  var theme = null
  try {
    theme = window.localStorage.getItem('wsuha-broute:theme')
  } catch (e) {
    theme = null
  }
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme)
  }
})()
