'use strict';
// Can phones on Wi-Fi reach this server? Looks at Windows Firewall rules for this exact node.exe.
// "Block" rules (Windows adds them when its "Allow access?" prompt is dismissed) beat "allow" rules.
const { execFile } = require('child_process');

const exe = process.execPath;

function ps(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout }, (err, out) => resolve(String(out || '').trim()));
  });
}

module.exports = {
  async check() {
    const out = await ps(
      `$r = @(Get-NetFirewallApplicationFilter -Program '${exe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' });` +
      `"$(@($r | Where-Object Action -eq 'Allow').Count),$(@($r | Where-Object Action -eq 'Block').Count)"`);
    const [allow, block] = out.split(',').map((n) => parseInt(n, 10) || 0);
    return { ok: block === 0 && allow > 0, allow, block };
  },
  /** One Windows permission prompt: remove block rules for PhoneDesk's server and add an allow rule. */
  async fix() {
    const cmd = `netsh advfirewall firewall delete rule name=all program="${exe}" >nul 2>&1 & netsh advfirewall firewall add rule name="PhoneDesk" dir=in action=allow enable=yes profile=any program="${exe}"`;
    await ps(`try { Start-Process cmd.exe -ArgumentList '/d /c ${cmd.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait } catch { }`, 120000);
    return this.check();
  },
};
