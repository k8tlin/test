// Loaded before the app. If the app's own files fail to load, the page would
// otherwise sit on "Loading..." for ever. This notices and says what went wrong.
(function () {
  'use strict'
  var failed = []
  window.addEventListener('error', function (event) {
    var el = event.target
    if (el && (el.tagName === 'SCRIPT' || el.tagName === 'LINK')) failed.push(el.src || el.href)
    else if (event.message) failed.push(event.message + (event.filename ? ' (' + event.filename + ')' : ''))
  }, true)

  function report () {
    if (window.__oneShelfAdminStarted) return
    var holder = document.querySelector('.loading')
    if (!holder) return
    holder.textContent = ''
    var lines = [
      'The admin could not start.',
      failed.length ? 'These could not be loaded:' : 'Its scripts did not run. Reload the page; if this continues, the server is not answering.'
    ].concat(failed.slice(0, 6))
    lines.push('Address: ' + location.pathname)
    lines.forEach(function (text) {
      var p = document.createElement('p')
      p.textContent = text
      holder.appendChild(p)
    })
    holder.setAttribute('role', 'alert')
  }
  window.addEventListener('load', function () { setTimeout(report, 4000) })
})()
