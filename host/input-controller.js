/**
 * Contrôle souris/clavier via un processus PowerShell persistant (Win32 API)
 */
const { spawn } = require('child_process')

let ps = null

// Script PowerShell qui tourne en boucle et exécute les commandes reçues sur stdin
const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
'@
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    try { Invoke-Expression $line } catch {}
}
`

function start() {
  ps = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  ps.stderr.on('data', d => console.error('[INPUT ERR]', d.toString().trim()))
  ps.on('exit', code => console.log('[INPUT] PS exit:', code))
  console.log('[INPUT] Contrôleur démarré')
}

function stop() {
  if (ps) { try { ps.stdin.end() } catch {} ps.kill(); ps = null }
}

function exec(cmd) {
  if (ps && ps.stdin.writable) ps.stdin.write(cmd + '\r\n')
}

// Conversion des touches JS → format SendKeys PowerShell
function mapKey(jsKey) {
  const map = {
    'Enter': '{ENTER}', 'Escape': '{ESC}', 'Backspace': '{BACKSPACE}',
    'Tab': '{TAB}', 'Delete': '{DELETE}', 'Insert': '{INSERT}',
    'Home': '{HOME}', 'End': '{END}', 'PageUp': '{PGUP}', 'PageDown': '{PGDN}',
    'ArrowUp': '{UP}', 'ArrowDown': '{DOWN}', 'ArrowLeft': '{LEFT}', 'ArrowRight': '{RIGHT}',
    'F1':'{F1}','F2':'{F2}','F3':'{F3}','F4':'{F4}','F5':'{F5}','F6':'{F6}',
    'F7':'{F7}','F8':'{F8}','F9':'{F9}','F10':'{F10}','F11':'{F11}','F12':'{F12}',
    ' ': ' '
  }
  if (map[jsKey]) return map[jsKey]
  if (jsKey.length === 1) {
    // Échapper les métacaractères SendKeys
    if ('+(^)%~{}'.includes(jsKey)) return `{${jsKey}}`
    return jsKey
  }
  return null
}

function handleInput(event, screenW, screenH) {
  switch (event.type) {
    case 'mousemove': {
      const x = Math.round(event.x * screenW)
      const y = Math.round(event.y * screenH)
      exec(`[WinAPI]::SetCursorPos(${x}, ${y})`)
      break
    }
    case 'mousedown': {
      // LEFTDOWN=2, RIGHTDOWN=8
      const flag = event.button === 2 ? 8 : 2
      exec(`[WinAPI]::mouse_event(${flag}, 0, 0, 0, 0)`)
      break
    }
    case 'mouseup': {
      // LEFTUP=4, RIGHTUP=16
      const flag = event.button === 2 ? 16 : 4
      exec(`[WinAPI]::mouse_event(${flag}, 0, 0, 0, 0)`)
      break
    }
    case 'wheel': {
      // WHEEL=2048, delta en multiples de 120
      const delta = Math.max(-3, Math.min(3, Math.round(-event.deltaY / 100)))
      const data = delta * 120
      if (data !== 0) exec(`[WinAPI]::mouse_event(2048, 0, 0, ${data > 0 ? data : 4294967296 + data}, 0)`)
      break
    }
    case 'keydown': {
      const key = mapKey(event.key)
      if (key) exec(`[System.Windows.Forms.SendKeys]::SendWait("${key}")`)
      break
    }
  }
}

module.exports = { start, stop, handleInput }
