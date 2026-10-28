/* Core logic: field extraction from OCR text + Excel row writer. Works in the browser and in Node (for tests). */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ fields
  const PERSON_FIELDS = [
    ['name', 'Name (as per Aadhaar)'], ['father', 'Father / Husband name'],
    ['relation', 'Relationship (FATHER / HUSBAND ...)'],
    ['fatherDob', 'Father / nominee date of birth (dd/mm/yyyy)'],
    ['dob', 'Date of birth (dd/mm/yyyy)'], ['gender', 'Gender (MALE / FEMALE)'],
    ['aadhaar', 'Aadhaar number'], ['mobile', 'Mobile number'],
    ['pan', 'PAN / Licence / Passport number'], ['email', 'Email'],
    ['blood', 'Blood group'], ['qualification', 'Qualification'],
    ['ifsc', 'IFSC code'], ['account', 'Bank account number'],
    ['bankHolder', 'Name as per bank records'], ['bankName', 'Bank name'],
    ['branch', 'Branch'], ['address', 'Address'], ['district', 'District'],
    ['state', 'State'], ['pin', 'PIN code'],
  ];
  const DEFAULT_FIELDS = [
    ['client', 'Client'], ['subContractor', 'Sub-contractor name'],
    ['doj', 'Date of joining (dd/mm/yyyy)'], ['esicWages', 'ESIC gross wages'],
    ['epfWages', 'EPF wages'], ['remitLoc', 'ESI remit location'],
    ['dispensary', 'Dispensary'], ['marital', 'Marital status (UNMARRIED / MARRIED)'],
  ];
  function newPerson() {
    const p = {};
    PERSON_FIELDS.forEach(f => p[f[0]] = '');
    p.licence = ''; p.bankAddress = '';
    return p;
  }
  function newDefaults() {
    return {
      client: 'AL UNIT-1 HOSUR', subContractor: 'TVS VEHICLE MOBILITY SOLUTION PRIVATE LIMITED',
      doj: '30/09/2026', esicWages: '19000', epfWages: '15000', remitLoc: 'HOSUR',
      dispensary: 'SIPCOT-1 HOSUR', marital: 'UNMARRIED',
    };
  }

  // ------------------------------------------------------------------ Verhoeff (Aadhaar check digit)
  const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
    [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
    [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  function verhoeff(num) {
    if (!/^\d+$/.test(num)) return false;
    let c = 0; const n = num.length;
    for (let i = 0; i < n; i++) c = D[c][P[i % 8][num.charCodeAt(n - 1 - i) - 48]];
    return c === 0;
  }
  function validAadhaar(s) { return !!s && /^[2-9]\d{11}$/.test(s) && verhoeff(s); }

  // ------------------------------------------------------------------ validation
  function parseDate(s) {
    if (!s) return null;
    const p = String(s).trim().split(/[\/\-.]/);
    if (p.length !== 3) return null;
    const d = +p[0], m = +p[1], y = +p[2];
    if (!(d >= 1 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1) return null;
    return dt;
  }
  function problem(key, value) {
    const v = (value || '').trim();
    if (['name', 'dob', 'aadhaar', 'mobile', 'ifsc', 'account'].includes(key)) { if (!v) return 'Required - please fill in'; }
    else if (!v) return null;
    switch (key) {
      case 'aadhaar':
        if (!/^\d{12}$/.test(v)) return 'Must be 12 digits';
        return validAadhaar(v) ? null : 'Check digit fails - a digit was probably misread';
      case 'mobile': return /^[6-9]\d{9}$/.test(v) ? null : 'Must be 10 digits';
      case 'dob': case 'fatherDob': return parseDate(v) ? null : 'Use dd/mm/yyyy';
      case 'ifsc': return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v) ? null : 'IFSC looks wrong';
      case 'pin': return /^\d{6}$/.test(v) ? null : 'Must be 6 digits';
      case 'email': return /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v) ? null : 'Email looks wrong';
      case 'account': return /^\d{8,18}$/.test(v) ? null : 'Account number looks wrong';
      case 'pan': return (/^[A-Z]{5}\d{4}[A-Z]$/.test(v) || v.length >= 6) ? null : 'Looks wrong';
      default: return null;
    }
  }

  // ------------------------------------------------------------------ document parsing
  const JUNK = ['GOVERNMENT','GOVT','INDIA','AUTHORITY','UNIQUE','IDENTIFICATION','MALE','FEMALE','DOB','ADDRESS','AADHAAR',
    'INCOME','TAX','DEPARTMENT','PERMANENT','ACCOUNT','NUMBER','CARD','FATHER','BIRTH','DATE','SIGNATURE','LICENCE','DRIVING',
    'BANK','BRANCH','VALID','BLOOD','GROUP','CATEGORY','TRANSPORT','KERALA','STATE','UNION','PHOTO'];
  const ADDR_WORDS = ['HOUSE','ROAD','STREET','COLONY','NAGAR','TOWN','VILLAGE','POST','OFFICE','DISTRICT','PIN','CODE','SAVINGS',
    'SCHEME','STANDARD','ACTIVE','SINGLE','REGISTERED','MODE','TYPE','EMAIL','MOBILE','CUSTOMER','EFFECTIVE','AVAILABLE','BALANCE',
    'PHONE','BANKING','PARTNER','YOUR','PERFECT','SWIFT','MICR','NOMINATION','CURRENCY','COMMUNICATION','UPDATED','OPEN','JOINT',
    'HOLDERS','SERVICES','UNIT','PLOT','SECTOR','NAVI','MUMBAI','LOST','FOUND','CASE','THIS'];
  const BANKS = {
    SBIN:'STATE BANK OF INDIA', IOBA:'INDIAN OVERSEAS BANK', CNRB:'CANARA BANK', FDRL:'FEDERAL BANK', IDIB:'INDIAN BANK',
    HDFC:'HDFC BANK', ICIC:'ICICI BANK', UTIB:'AXIS BANK', KARB:'KARNATAKA BANK', CIUB:'CITY UNION BANK',
    UBIN:'UNION BANK OF INDIA', BARB:'BANK OF BARODA', PUNB:'PUNJAB NATIONAL BANK', KVBL:'KARUR VYSYA BANK',
    TMBL:'TAMILNAD MERCANTILE BANK', SIBL:'SOUTH INDIAN BANK', IDFB:'IDFC FIRST BANK', BKID:'BANK OF INDIA',
    CBIN:'CENTRAL BANK OF INDIA', UCBA:'UCO BANK', INDB:'INDUSIND BANK', KKBK:'KOTAK MAHINDRA BANK', YESB:'YES BANK',
    IPOS:'INDIA POST PAYMENTS BANK', PYTM:'PAYTM PAYMENTS BANK', DLXB:'DHANLAXMI BANK', CSBK:'CSB BANK',
    KLGB:'KERALA GRAMIN BANK', MAHB:'BANK OF MAHARASHTRA', PSIB:'PUNJAB & SIND BANK', AIRP:'AIRTEL PAYMENTS BANK',
    ESFB:'EQUITAS SMALL FINANCE BANK', AUBL:'AU SMALL FINANCE BANK', TNSC:'TAMILNADU STATE APEX CO-OP BANK',
  };
  const BANK_NAMES = ['FEDERAL BANK','STATE BANK OF INDIA','CANARA BANK','INDIAN OVERSEAS BANK','INDIAN BANK','HDFC BANK','ICICI BANK',
    'AXIS BANK','UNION BANK OF INDIA','BANK OF BARODA','KARNATAKA BANK','CITY UNION BANK'];

  const DATE_RE = /(?<!\d)(\d{2})\s*[\/\-.]\s*(\d{2})\s*[\/\-.]\s*(\d{4})(?!\d)/g;
  const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

  const flat = t => t.replace(/[\r\n]+/g, ' ');
  const hasWord = (u, w) => new RegExp('\\b' + w + '\\b').test(u);

  function findAadhaar(text) {
    const re = /(?<!\d)(\d{4})\s?(\d{4})\s?(\d{4})(?!\d)/g; let m;
    while ((m = re.exec(text))) { const s = m[1] + m[2] + m[3]; if (validAadhaar(s)) return s; }
    return null;
  }
  const toLetter = c => ({ '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' }[c] || c);
  const toDigit = c => ({ O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' }[c] || c);
  function findPan(up) {
    const re = /(?<![A-Z0-9])[A-Z0-9]{10}(?![A-Z0-9])/g; let m;
    while ((m = re.exec(up))) {
      const t = m[0];
      if (PAN_RE.test(t)) return t;
      let letters = 0; for (let i = 0; i < 5; i++) if (/[A-Z]/.test(t[i])) letters++;
      if (letters < 3) continue;
      let sb = '';
      for (let i = 0; i < 10; i++) sb += (i < 5 || i === 9) ? toLetter(t[i]) : toDigit(t[i]);
      if (PAN_RE.test(sb)) return sb;
    }
    return null;
  }
  function findDob(lines) {
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(DATE_RE.source, 'g'); let m;
      while ((m = re.exec(lines[i]))) {
        const ctx = (lines[i] + ' ' + (i > 0 ? lines[i - 1] : '')).toUpperCase();
        if (!(ctx.includes('BIRTH') || ctx.includes('DOB') || ctx.includes('D.O.B') || ctx.includes('जन्म'))) continue;
        const d = +m[1], mo = +m[2], y = +m[3];
        if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 1940 || y > 2015) continue;
        return m[1] + '/' + m[2] + '/' + m[3];
      }
    }
    return '';
  }
  function isNameLine(s) {
    if (!s) return false; s = s.trim();
    if (!/^[A-Za-z][A-Za-z .']{1,38}[A-Za-z.]$/.test(s)) return false;
    const u = s.toUpperCase();
    return !JUNK.some(j => hasWord(u, j));
  }
  function cleanName(s) {
    s = s.trim().replace(/\s{2,}.*$/, '').replace(/\s+Branch.*$/i, '');
    return s.replace(/[^A-Za-z .']/g, '').trim();
  }
  function aadhaarName(lines) {
    for (let i = 0; i < lines.length; i++) {
      const u = lines[i].toUpperCase();
      if ((u.includes('DOB') || u.includes('D.O.B') || u.includes('DATE OF BIRTH') || u.includes('YEAR OF BIRTH')) && new RegExp(DATE_RE.source).test(lines[i])) {
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) { const n = cleanName(lines[j]); if (isNameLine(n)) return n; }
      }
    }
    return '';
  }
  function nameAfterLabel(lines, label, exclude) {
    for (let i = 0; i < lines.length; i++) {
      const u = lines[i].toUpperCase();
      if (!u.includes(label)) continue;
      if (exclude && u.includes(exclude)) continue;
      if (u.includes('ACCOUNT') || u.includes('DEPARTMENT')) continue;
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 2); j++) { const n = cleanName(lines[j]); if (isNameLine(n)) return n; }
    }
    return '';
  }
  function cleanAddr(a) {
    return a.replace(/§/g, 'S').replace(/[\[\]|=<>~_;"]/g, ' ').replace(/\bS\.0\b/gi, 'S.O')
      .replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/(,\s*){2,}/g, ', ').replace(/^[,.\s]+/, '').trim();
  }
  function readAadhaarAddress(text, p) {
    let m = /Address\s*:?\s*(.{5,300}?)(?<!\d)(\d{6})(?!\d)/is.exec(flat(text));
    if (!m) { m = /\b([SDWC]\s*\/\s*O\b.{5,300}?)(?<!\d)(\d{6})(?!\d)/is.exec(flat(text)); if (!m) return; }
    let a = m[1].trim(); const pin = m[2];
    const so = /^([SDWCH])\s*\/\s*O\s*:?\s*([^,.]+)[,.]\s*(.*)$/i.exec(a);
    if (so) {
      const kind = so[1].toUpperCase(); const who = cleanName(so[2]);
      if (who && kind !== 'C') { p.father = who; p.relation = kind === 'W' ? 'HUSBAND' : 'FATHER'; }
      a = so[3];
    }
    const tokens = [];
    a.split(',').forEach(t => { const s = t.replace(/\s+/g, ' ').trim(); if (s && s !== '.') tokens.push(s.toUpperCase()); });
    if (tokens.length < 2) return;
    const state = tokens.pop().replace('TAMIL NADU', 'TAMILNADU');
    const district = tokens.length ? tokens[tokens.length - 1] : '';
    p.state = state; p.district = district; p.pin = pin;
    p.address = cleanAddr(tokens.join(', ') + ', ' + state + '. ' + pin);
  }
  function excludeDigits(lines) {
    let sb = '|';
    lines.forEach(l => {
      const u = l.toUpperCase();
      if (u.includes('CUSTOMER') || u.includes('MICR') || u.includes('MOBILE') || u.includes('SOL ID') || u.includes('REGD')) {
        (l.match(/(?<!\d)\d{6,18}(?!\d)/g) || []).forEach(d => sb += d + '|');
      }
    });
    return sb;
  }
  function readBank(text, lines, p) {
    const up = text.toUpperCase(); let m;
    const re = /(?<![A-Z0-9])([A-Z0-9]{4})([0O])([A-Z0-9]{6})(?![A-Z0-9])/g;
    while ((m = re.exec(up))) {
      const first = m[1].replace(/0/g, 'O').replace(/1/g, 'I');
      if (!/^[A-Z]{4}$/.test(first)) continue;
      if (BANKS[first] || up.includes('IFSC')) { p.ifsc = first + '0' + m[3]; break; }
    }
    const ex = excludeDigits(lines);
    for (let i = 0; i < lines.length && !p.account; i++) {
      const u = lines[i].toUpperCase();
      if (u.includes('ACCOUNT NUMBER') || u.includes('ACCOUNT NO') || u.includes('A/C NO')) {
        for (let j = i; j <= Math.min(lines.length - 1, i + 2) && !p.account; j++) {
          const dr = /(?<!\d)(\d{9,18})(?!\d)/g; let d;
          while ((d = dr.exec(lines[j]))) { if (!ex.includes('|' + d[1] + '|')) { p.account = d[1]; break; } }
        }
      }
    }
    if (!p.account) {
      let best = ''; const dr = /(?<!\d)(\d{11,18})(?!\d)/g; let d;
      while ((d = dr.exec(text))) { if (ex.includes('|' + d[1] + '|')) continue; if (d[1].length > best.length) best = d[1]; }
      p.account = best;
    }
    const h = /^\W*Name\s*[:\-]\s*(.+)$/im.exec(text);
    if (h) { const n = cleanName(h[1]); if (isNameLine(n)) p.bankHolder = n; }
    if (!p.bankHolder) {
      const h2 = /\bNa\w{1,2}\W{1,3}([A-Za-z][A-Za-z .]{2,40}?)\s+Branch/i.exec(text);
      if (h2) { const n = cleanName(h2[1]); if (isNameLine(n)) p.bankHolder = n; }
    }
    const br = /Branch[ \t]*Name[ \t]*[:\-]?[ \t]*([A-Za-z][A-Za-z .&\-]{1,40})/i.exec(text);
    if (br) {
      const b = br[1].replace(/\s+/g, ' ').trim(), bu = b.toUpperCase();
      if (!/\b(NAME|ADDRESS|COMMUNICATION|SOL|ACCOUNT|NUMBER|CODE|UPDATED)\b/.test(bu)) p.branch = b;
    }
    // address printed on the bank sheet (usually the cleanest copy)
    const ba = /Communication\s*Address\W{0,3}(.{5,200}?)(?<!\d)(\d{6})(?!\d)/is.exec(flat(text));
    if (ba) {
      // the sheet has two columns, so label words of the other column can leak into the address
      const toks = cleanAddr(ba[1]).replace(/\b(BRANCH|SOL|ID|NAME|ACCOUNT|NUMBER)\b/gi, ' ').replace(/(?<![\/\d])\b\d{4,6}\b(?![\/\d])/g, ' ').replace(/INDIA\W*$/i, '').split(',')
        .map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t && t !== '.' && !/^(KERALA|INDIA|TAMIL ?NADU|KARNATAKA|ANDHRA PRADESH|TELANGANA)$/i.test(t));
      p.bankAddress = (toks.join(', ') + '|' + ba[2]).toUpperCase();
    }
    for (const b of BANK_NAMES) if (up.includes(b)) { p.bankName = b; break; }
  }
  function findMobile(lines) {
    const pt = /(?<!\d)(?:\+?91[\s\-]?)?([6-9]\d{9})(?!\d)/;
    for (const l of lines) {
      const u = l.toUpperCase();
      if (u.includes('MOBILE') || u.includes('MOB.') || u.includes('PHONE')) { const m = pt.exec(l); if (m) return m[1]; }
    }
    return '';
  }
  function findEmail(lines) {
    let fallback = '';
    for (const l of lines) {
      const re = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g; let m;
      while ((m = re.exec(l))) {
        const e = m[0].toLowerCase();
        if (e.includes('federalbank') || e.includes('uidai') || e.endsWith('.gov.in') || e.startsWith('contact@') || e.startsWith('help@')) continue;
        if (l.toUpperCase().includes('EMAIL')) return e;
        if (!fallback) fallback = e;
      }
    }
    return fallback;
  }
  function consensusName(texts) {
    const count = {}; const pt = /\b[A-Z][A-Za-z]{2,}(?:[ \t]+[A-Z][A-Za-z]*\.?){1,2}/g;
    texts.forEach(t => {
      const seen = new Set(); let m; pt.lastIndex = 0;
      while ((m = pt.exec(t))) {
        const c = m[0].trim().replace(/\s+/g, ' ').toUpperCase();
        if (!isNameLine(c)) continue;
        if (ADDR_WORDS.some(w => hasWord(c, w))) continue;
        seen.add(c);
      }
      seen.forEach(c => count[c] = (count[c] || 0) + 1);
    });
    let best = '', bc = 1;
    Object.keys(count).forEach(k => { if (count[k] > bc || (count[k] === bc && bc > 1 && k.length < best.length)) { best = k; bc = count[k]; } });
    return best;
  }
  function consensusDob(texts) {
    const count = {};
    texts.forEach(t => {
      const seen = new Set(); const re = new RegExp(DATE_RE.source, 'g'); let m;
      while ((m = re.exec(t))) {
        const d = +m[1], mo = +m[2], y = +m[3];
        if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 1950 || y > 2010) continue;
        seen.add(m[1] + '/' + m[2] + '/' + m[3]);
      }
      seen.forEach(c => count[c] = (count[c] || 0) + 1);
    });
    let best = '', bc = 1;
    Object.keys(count).forEach(k => { if (count[k] > bc) { best = k; bc = count[k]; } });
    return best;
  }

  function parseOne(text) {
    const d = { rank: 4, p: newPerson() }; const p = d.p;
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const up = text.toUpperCase();
    let aad = findAadhaar(text);
    const bank = up.includes('IFSC') || up.includes('ACCOUNT NUMBER') || up.includes('A/C NO');
    const pan = up.includes('INCOME TAX') || up.includes('PERMANENT ACCOUNT');
    const dl = up.includes('DRIVING') || up.includes('LICENCE') || up.includes('LICENSE');
    const aadhaarWords = up.includes('AADHAAR') || up.includes('UIDAI') || up.includes('UNIQUE IDENTIFICATION');
    if (aad && bank && !aadhaarWords) aad = null;
    const aadhaar = aadhaarWords || (aad && !pan && !dl);
    if (aadhaar) d.rank = Math.min(d.rank, 0);
    if (pan) d.rank = Math.min(d.rank, 1);
    if (dl) d.rank = Math.min(d.rank, 2);
    if (bank) d.rank = Math.min(d.rank, 3);
    if (aad) p.aadhaar = aad;
    const dob = findDob(lines); if (dob) p.dob = dob;
    if (aadhaar) {
      if (hasWord(up, 'FEMALE')) p.gender = 'FEMALE'; else if (hasWord(up, 'MALE')) p.gender = 'MALE';
      p.name = aadhaarName(lines);
      readAadhaarAddress(text, p);
    }
    if (pan) {
      const n = nameAfterLabel(lines, 'NAME', 'FATHER'); if (!p.name) p.name = n;
      const f = nameAfterLabel(lines, 'FATHER', null); if (!p.father) p.father = f;
    }
    if (dl) {
      const m = /^\W*Name\s*[:\-]?\s+(.+)$/im.exec(text);
      if (m) { const n = cleanName(m[1]); if (!p.name && isNameLine(n)) p.name = n; }
      const f = /S\s*\/\s*[WD]\s*\/\s*[WD]\s*of\W*([A-Za-z .]+)/i.exec(text);
      if (f) { const n = cleanName(f[1]); if (isNameLine(n)) p.father = n; }
      const l = /(?<!\d)(\d{2}\/\d{3,5}\/\d{4})(?!\d)/.exec(text);
      if (l) p.licence = l[1];
      else { const l2 = /\b([A-Z]{2}\d{2}\s?\d{11})\b/.exec(up); if (l2) p.licence = l2[1].replace(' ', ''); }
      if (!p.address) {
        const a = /Address\W{0,3}(.{5,200}?)(?<!\d)(\d{6})(?!\d)/is.exec(flat(text));
        if (a) { p.address = cleanAddr(a[1]).toUpperCase(); p.pin = a[2]; }
      }
    }
    const bg = /b[il1]ood\s*gr\w*\W{0,4}(AB|A|B|O)\s*([+\-]|pos|neg)/i.exec(text);
    if (bg) p.blood = bg[1].toUpperCase() + ((bg[2].startsWith('-') || bg[2].toLowerCase().startsWith('n')) ? '-VE' : '+VE');
    const pn = findPan(up); if (pn) p.pan = pn;
    if (bank) readBank(text, lines, p);
    if (!p.mobile) p.mobile = findMobile(lines);
    if (!p.email) p.email = findEmail(lines);
    return d;
  }
  function addrScore(cand, ownIdx, texts) {
    const words = (cand.match(/[A-Za-z]{3,}/g) || []);
    if (!words.length) return 0;
    let ok = 0;
    words.forEach(w => {
      const re = new RegExp('\\b' + w + '\\b', 'i');
      if (texts.some((t, i) => i !== ownIdx && re.test(t))) ok++;
    });
    return ok / words.length;
  }
  function finish(p) {
    p.name = p.name.toUpperCase();
    if (!p.name) p.name = p.bankHolder.toUpperCase();
    p.father = p.father.toUpperCase();
    if (!p.relation) p.relation = 'FATHER';
    ['bankHolder', 'branch', 'address', 'district', 'state', 'ifsc', 'pan'].forEach(k => p[k] = p[k].toUpperCase());
    if (!p.pan) p.pan = p.licence.toUpperCase();
    p.email = p.email.toLowerCase();
    p.aadhaar = p.aadhaar.replace(/\D/g, '');
    p.mobile = p.mobile.replace(/\D/g, '');
    if (p.mobile.length === 12 && p.mobile.startsWith('91')) p.mobile = p.mobile.substring(2);
    if (p.mobile === p.account) p.mobile = '';
    if (!p.bankName && p.ifsc.length >= 4) { const b = BANKS[p.ifsc.substring(0, 4)]; if (b) p.bankName = b; }
    if (!p.bankHolder) p.bankHolder = p.name;
  }
  function parseAll(texts) {
    const docs = [];
    texts.forEach((t, i) => { if (t && t.trim()) { const d = parseOne(t); d.idx = i; d.order = i; docs.push(d); } });
    docs.sort((a, b) => a.rank - b.rank || a.order - b.order);
    const out = newPerson(); out.relation = '';
    // each field: the value most documents / passes agree on (ties: the better document type)
    Object.keys(out).forEach(k => {
      if (k === 'address' || k === 'bankAddress') return;
      const votes = new Map();
      docs.forEach(d => { const v = d.p[k]; if (v) { const key = k === 'email' ? v.toLowerCase() : v.toUpperCase(); const e = votes.get(key) || { v, n: 0 }; e.n++; votes.set(key, e); } });
      let best = null; votes.forEach(e => { if (!best || e.n > best.n) best = e; });
      if (best) out[k] = best.v;
    });
    // address: take the candidate whose words are confirmed by the other documents
    const cands = [];
    docs.forEach(d => {
      if (d.p.address) cands.push({ text: d.p.address, own: d.idx, score: 0, bank: false, d });
      if (d.p.bankAddress) { const parts = d.p.bankAddress.split('|'); cands.push({ text: parts[0], pin: parts[1], own: d.idx, score: 0, bank: true, d }); }
    });
    cands.forEach(c => c.score = addrScore(c.text, c.own, texts) + (c.bank ? 0.05 : 0));
    cands.sort((a, b) => b.score - a.score);
    if (cands.length) {
      const c = cands[0];
      if (!c.bank) out.address = c.text;
      else {
        const withDistrict = docs.map(d => d.p).find(p => p.district && p.address);
        const tail = [];
        if (withDistrict) { tail.push(withDistrict.district); if (withDistrict.state) tail.push(withDistrict.state); }
        else if (out.state) tail.push(out.state);
        out.address = c.text.replace(/[,\s]+$/, '') + (tail.length ? ', ' + tail.join(', ') : '') + '. ' + c.pin;
        if (!out.pin) out.pin = c.pin;
      }
    }
    if (!out.name && !out.bankHolder) out.name = consensusName(texts);
    if (!out.dob) out.dob = consensusDob(texts);
    out.address = cleanAddr(out.address);
    finish(out);
    delete out.bankAddress;
    return out;
  }

  // ------------------------------------------------------------------ template row mapping
  function dateSerial(s) {
    const d = parseDate(s); if (!d) return s || '';
    return Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
  }
  function num(s) {
    const t = (s || '').trim();
    if (/^\d{1,15}$/.test(t)) return Number(t);
    return t;
  }
  function buildRow(p, d) {
    const r = {};
    r.K = p.name; r.L = p.father; r.M = dateSerial(p.dob); r.N = dateSerial(d.doj);
    r.Q = p.gender; r.R = d.marital; r.S = d.client; r.T = d.subContractor;
    r.U = p.aadhaar; r.V = num(p.mobile); r.W = p.pan; r.X = p.email; r.Y = p.blood; r.Z = p.qualification;
    r.AA = num(d.esicWages); r.AB = num(d.epfWages);
    r.AC = p.ifsc; r.AD = p.account; r.AE = p.bankHolder; r.AF = p.bankName; r.AG = p.branch;
    r.AH = d.remitLoc; r.AI = d.dispensary;
    r.AJ = p.address; r.AK = p.district; r.AL = p.state; r.AM = num(p.pin);
    r.AN = p.address; r.AO = p.district; r.AP = p.state; r.AQ = num(p.pin);
    r.AR = p.father; r.AS = p.relation;
    r.AT = p.address; r.AU = p.district; r.AV = p.state; r.AW = num(p.pin);
    r.AX = p.father; r.AY = dateSerial(p.fatherDob); r.AZ = p.relation; r.BA = p.father ? 'YES' : '';
    r.BB = p.district; r.BC = p.state;
    return r;
  }

  // ------------------------------------------------------------------ zip (read: inflate via browser/Node streams; write: stored)
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function inflateRaw(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function readZip(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('This is not a valid Excel (.xlsx) file');
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const files = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged Excel file');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      const lnl = dv.getUint16(off + 26, true), lel = dv.getUint16(off + 28, true);
      const start = off + 30 + lnl + lel; const raw = u8.subarray(start, start + csize);
      if (!name.endsWith('/')) files.set(name, method === 0 ? raw.slice() : await inflateRaw(raw));
      p += 46 + nl + el + cl;
    }
    return files;
  }
  function writeZip(files) {
    const parts = [], central = []; let off = 0;
    files.forEach((data, name) => {
      const nb = enc.encode(name), crc = crc32(data);
      const lh = new Uint8Array(30 + nb.length); const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, nb.length, true); lh.set(nb, 30);
      parts.push(lh, data);
      const ch = new Uint8Array(46 + nb.length); const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true); ch.set(nb, 46);
      central.push(ch); off += lh.length + data.length;
    });
    let csz = 0; central.forEach(c => csz += c.length);
    const end = new Uint8Array(22); const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
    ev.setUint32(12, csz, true); ev.setUint32(16, off, true);
    return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ------------------------------------------------------------------ xlsx: add a row to the first sheet
  const ROW_RE = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  const CELL_RE = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  const attr = (tag, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
  const colOf = tag => (attr(tag, 'r') || '').replace(/\d/g, '');
  const cellHasValue = c => c.includes('<v>') || c.includes('<is>') || c.includes('<f');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function sheetPath(files) {
    const wb = files.get('xl/workbook.xml'), rel = files.get('xl/_rels/workbook.xml.rels');
    if (!wb || !rel) throw new Error('Not a valid Excel (.xlsx) file');
    const wbs = dec.decode(wb); const sm = /<sheet\b[^>]*>/.exec(wbs);
    if (!sm) throw new Error('No sheet found in the workbook');
    const rid = attr(sm[0], 'r:id'); const rels = dec.decode(rel); let m; const re = /<Relationship\b[^>]*>/g;
    while ((m = re.exec(rels))) {
      if (rid && attr(m[0], 'Id') === rid) { const t = attr(m[0], 'Target'); return t.startsWith('/') ? t.slice(1) : 'xl/' + t; }
    }
    throw new Error('Could not locate the first sheet');
  }
  function analyse(xml) {
    const info = { lastRow: 0, serial: 0 }; let rm;
    const re = new RegExp(ROW_RE.source, 'g');
    while ((rm = re.exec(xml))) {
      const nm = /^<row\b[^>]*?\br="(\d+)"/.exec(rm[0]); if (!nm) continue;
      const n = +nm[1]; if (n < 3) continue;
      let hasName = false, aCell = ''; const cr = new RegExp(CELL_RE.source, 'g'); let cm;
      while ((cm = cr.exec(rm[0]))) {
        const col = colOf(cm[0]);
        if (['K', 'U', 'AD'].includes(col) && cellHasValue(cm[0])) hasName = true;
        if (col === 'A') aCell = cm[0];
      }
      if (hasName && n > info.lastRow) {
        info.lastRow = n; let s = info.serial + 1;
        const v = /<v>([^<]*)<\/v>/.exec(aCell);
        if (v && !aCell.includes('t="s"') && !isNaN(parseFloat(v[1]))) s = Math.trunc(parseFloat(v[1]));
        info.serial = s;
      }
    }
    return info;
  }
  async function inspectXlsx(buf) {
    const files = await readZip(buf);
    const info = analyse(dec.decode(files.get(sheetPath(files))));
    const wbs = dec.decode(files.get('xl/workbook.xml')); const sm = /<sheet\b[^>]*>/.exec(wbs);
    info.sheetName = sm ? (attr(sm[0], 'name') || '') : '';
    return info;
  }
  function cellXml(col, row, style, v) {
    const ref = col + row, s = style == null ? '' : ' s="' + style + '"';
    if (v == null || v === '') return '<c r="' + ref + '"' + s + '/>';
    if (typeof v === 'number') return '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>';
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }
  /** Returns { blob, bytes, row } where bytes is the new .xlsx content. */
  async function appendRow(buf, values) {
    const files = await readZip(buf); const path = sheetPath(files);
    let xml = dec.decode(files.get(path)); const info = analyse(xml);
    if (!info.lastRow) throw new Error('Could not find an example data row in the template (column K, row 3 or below)');
    const newRow = info.lastRow + 1;
    let srcRow = null, rm; const re = new RegExp(ROW_RE.source, 'g');
    while ((rm = re.exec(xml))) { const nm = /^<row\b[^>]*?\br="(\d+)"/.exec(rm[0]); if (nm && +nm[1] === info.lastRow) { srcRow = rm[0]; break; } }
    if (!srcRow) throw new Error('Example row missing');
    let openTag = /^<row\b[^>]*?>/.exec(srcRow)[0];
    if (openTag.endsWith('/>')) openTag = openTag.slice(0, -2) + '>';
    openTag = openTag.replace(/\br="\d+"/, 'r="' + newRow + '"');
    const all = Object.assign({}, values, { A: info.serial + 1 });
    let row = openTag; const done = new Set(); const cr = new RegExp(CELL_RE.source, 'g'); let cm;
    while ((cm = cr.exec(srcRow))) {
      const col = colOf(cm[0]); if (!col) continue;
      const head = cm[0].slice(0, cm[0].indexOf('>') + 1);
      row += cellXml(col, newRow, attr(head, 's'), all[col]); done.add(col);
    }
    Object.keys(all).forEach(k => { if (!done.has(k)) row += cellXml(k, newRow, null, all[k]); });
    row += '</row>';
    let out = null; const re2 = new RegExp(ROW_RE.source, 'g');
    while ((rm = re2.exec(xml))) {
      const nm = /^<row\b[^>]*?\br="(\d+)"/.exec(rm[0]); if (!nm) continue; const n = +nm[1];
      if (n === newRow) { out = xml.slice(0, rm.index) + row + xml.slice(rm.index + rm[0].length); break; }
      if (n > newRow) { out = xml.slice(0, rm.index) + row + xml.slice(rm.index); break; }
    }
    if (out === null) { const i = xml.indexOf('</sheetData>'); if (i < 0) throw new Error('Sheet has no data section'); out = xml.slice(0, i) + row + xml.slice(i); }
    out = out.replace(/<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/, (all0, a, b, c, d) => +d < newRow ? '<dimension ref="' + a + b + ':' + c + newRow + '"/>' : all0);
    files.set(path, enc.encode(out));
    const blob = writeZip(files);
    return { blob, bytes: new Uint8Array(await blob.arrayBuffer()), row: newRow };
  }

  root.UAN = { PERSON_FIELDS, DEFAULT_FIELDS, newPerson, newDefaults, validAadhaar, problem, parseAll, buildRow, inspectXlsx, appendRow, parseDate };
  if (typeof module !== 'undefined') module.exports = root.UAN;
})(typeof window !== 'undefined' ? window : globalThis);
