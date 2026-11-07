'use strict';
// Where PhoneDesk keeps its settings and downloads.
// Installed copies get PHONEDESK_DATA=%APPDATA%\PhoneDesk from the tray app so settings survive updates.
// Running from source keeps everything next to the code.
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.PHONEDESK_DATA || path.join(ROOT, 'data');
const TOOLS = process.env.PHONEDESK_DATA ? path.join(DATA, 'tools') : path.join(ROOT, 'tools');

module.exports = { ROOT, DATA, TOOLS };
