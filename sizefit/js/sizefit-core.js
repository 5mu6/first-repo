/*
 * SizeFit core: reads Chinese (and agent-translated English) size charts,
 * converts units, builds a body model from the user's measurements and
 * scores every size in the chart.
 *
 * Works in the browser (window.SizeFit) and in Node (module.exports).
 * All internal lengths are centimetres, all weights are kilograms.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SizeFit = Object.assign(root.SizeFit || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------
  const CM_PER_IN = 2.54;
  const CM_PER_SHICUN = 10 / 3; // 市寸 (Chinese inch) = 3.333 cm, 1 尺 = 10 寸
  const KG_PER_JIN = 0.5; // 斤
  const KG_PER_LB = 0.45359237;

  const round1 = (v) => Math.round(v * 10) / 10;
  const cmToIn = (cm) => cm / CM_PER_IN;
  const inToCm = (inch) => inch * CM_PER_IN;
  const kgToLb = (kg) => kg / KG_PER_LB;
  const lbToKg = (lb) => lb * KG_PER_LB;

  function fmtLen(cm, units, digits) {
    if (cm == null || !isFinite(cm)) return '–';
    if (units === 'in') {
      const v = cmToIn(cm);
      return (digits == null ? (Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(1)) : v.toFixed(digits)).replace(/\.0$/, '') + '″';
    }
    return (digits == null ? round1(cm) : cm.toFixed(digits)) + ' cm';
  }
  function fmtWeight(kg, units) {
    if (kg == null || !isFinite(kg)) return '–';
    return units === 'lb' ? Math.round(kgToLb(kg)) + ' lb' : round1(kg) + ' kg';
  }
  function fmtHeightImperial(cm) {
    const totalIn = Math.round(cmToIn(cm));
    return Math.floor(totalIn / 12) + "′" + (totalIn % 12) + '″';
  }

  // ---------------------------------------------------------------------------
  // Vocabulary: Chinese + English measurement names
  // ---------------------------------------------------------------------------
  // half: true means the value is a flat ("平铺") half measurement.
  const MEASURE_DEFS = {
    length:     { label: 'Length', zh: '衣长', kind: 'len' },
    chest:      { label: 'Chest', zh: '胸围', kind: 'circ' },
    shoulder:   { label: 'Shoulder', zh: '肩宽', kind: 'len' },
    sleeve:     { label: 'Sleeve', zh: '袖长', kind: 'len' },
    fullSleeve: { label: 'Cuff-to-cuff', zh: '通袖长', kind: 'len' },
    neckSleeve: { label: 'Neck-to-cuff', zh: '肩袖长', kind: 'len' },
    waist:      { label: 'Waist', zh: '腰围', kind: 'circ' },
    hip:        { label: 'Hip', zh: '臀围', kind: 'circ' },
    hem:        { label: 'Hem', zh: '下摆', kind: 'circ' },
    cuff:       { label: 'Cuff', zh: '袖口', kind: 'circ' },
    bicep:      { label: 'Bicep', zh: '袖肥', kind: 'circ' },
    neck:       { label: 'Neck', zh: '领围', kind: 'circ' },
    outseam:    { label: 'Pant length', zh: '裤长', kind: 'len' },
    inseam:     { label: 'Inseam', zh: '内长', kind: 'len' },
    rise:       { label: 'Front rise', zh: '前裆', kind: 'len' },
    backRise:   { label: 'Back rise', zh: '后裆', kind: 'len' },
    thigh:      { label: 'Thigh', zh: '大腿围', kind: 'circ' },
    knee:       { label: 'Knee', zh: '膝围', kind: 'circ' },
    legOpening: { label: 'Leg opening', zh: '脚口', kind: 'circ' },
    skirtLength:{ label: 'Skirt/dress length', zh: '裙长', kind: 'len' },
    height:     { label: 'Suggested height', zh: '身高', kind: 'height' },
    weight:     { label: 'Suggested weight', zh: '体重', kind: 'weight' },
    footLength: { label: 'Foot length', zh: '脚长', kind: 'foot' },
    insole:     { label: 'Insole length', zh: '内长', kind: 'foot' },
    euSize:     { label: 'EU size', zh: '欧码', kind: 'shoesize' },
    usSize:     { label: 'US size', zh: '美码', kind: 'shoesize' },
    head:       { label: 'Head', zh: '头围', kind: 'circ' },
  };

  // [alias, key, isHalf]. Longest aliases are matched first.
  const ALIASES = [
    // tops
    ['衣长', 'length'], ['后中长', 'length'], ['后衣长', 'length'], ['前衣长', 'length'], ['后中', 'length'],
    ['身长', 'length'], ['总长', 'length'], ['全长', 'length'], ['衣服长', 'length'], ['长度', 'length'], ['上衣长', 'length'],
    ['胸围', 'chest'], ['胸周', 'chest'], ['半胸围', 'chest', true], ['1/2胸围', 'chest', true], ['胸宽', 'chest', true],
    ['平铺胸围', 'chest', true], ['胸围平铺', 'chest', true], ['胸围(平铺)', 'chest', true], ['单胸围', 'chest', true],
    ['肩宽', 'shoulder'], ['肩阔', 'shoulder'], ['肩', 'shoulder'],
    ['袖长', 'sleeve'], ['袖子长', 'sleeve'], ['通袖长', 'fullSleeve'], ['通袖', 'fullSleeve'], ['肩袖长', 'neckSleeve'], ['领袖长', 'neckSleeve'],
    ['下摆围', 'hem'], ['下摆', 'hem'], ['摆围', 'hem'], ['下摆宽', 'hem', true], ['摆宽', 'hem', true],
    ['袖口', 'cuff'], ['袖口围', 'cuff'], ['袖口宽', 'cuff', true],
    ['袖肥', 'bicep', true], ['袖宽', 'bicep', true], ['臂围', 'bicep'], ['袖围', 'bicep'],
    ['领围', 'neck'], ['颈围', 'neck'],
    // shared
    ['腰围', 'waist'], ['腰', 'waist'], ['半腰围', 'waist', true], ['1/2腰围', 'waist', true], ['腰宽', 'waist', true],
    ['平铺腰围', 'waist', true], ['腰围平铺', 'waist', true], ['腰围(平铺)', 'waist', true],
    ['臀围', 'hip'], ['臀', 'hip'], ['半臀围', 'hip', true], ['1/2臀围', 'hip', true], ['臀宽', 'hip', true],
    ['平铺臀围', 'hip', true], ['臀围平铺', 'hip', true], ['臀围(平铺)', 'hip', true],
    // bottoms
    ['裤长', 'outseam'], ['外长', 'outseam'], ['裤子长', 'outseam'], ['外侧长', 'outseam'], ['裤全长', 'outseam'],
    ['内长', 'inseam'], ['内裆长', 'inseam'], ['内侧长', 'inseam'], ['内缝长', 'inseam'], ['裆下长', 'inseam'], ['内裆', 'inseam'],
    ['前裆', 'rise'], ['前浪', 'rise'], ['立裆', 'rise'], ['直裆', 'rise'], ['裆深', 'rise'], ['前裆长', 'rise'], ['浪', 'rise'],
    ['后裆', 'backRise'], ['后浪', 'backRise'], ['后裆长', 'backRise'],
    ['大腿围', 'thigh'], ['腿围', 'thigh'], ['大腿宽', 'thigh', true], ['腿宽', 'thigh', true], ['横裆', 'thigh', true], ['半腿围', 'thigh', true],
    ['膝围', 'knee'], ['膝宽', 'knee', true], ['中腿围', 'knee'],
    ['脚口', 'legOpening'], ['裤脚', 'legOpening'], ['裤口', 'legOpening'], ['脚围', 'legOpening'], ['裤脚口', 'legOpening'], ['脚口宽', 'legOpening', true],
    ['裙长', 'skirtLength'], ['裙子长', 'skirtLength'],
    // body recommendations
    ['身高', 'height'], ['建议身高', 'height'], ['适合身高', 'height'], ['参考身高', 'height'], ['推荐身高', 'height'], ['适穿身高', 'height'], ['适用身高', 'height'],
    ['体重', 'weight'], ['建议体重', 'weight'], ['适合体重', 'weight'], ['参考体重', 'weight'], ['推荐体重', 'weight'], ['适穿体重', 'weight'], ['适用体重', 'weight'],
    // shoes / hats
    ['脚长', 'footLength'], ['适合脚长', 'footLength'], ['建议脚长', 'footLength'], ['脚掌长', 'footLength'],
    ['鞋内长', 'insole'], ['内底长', 'insole'], ['鞋垫长', 'insole'],
    ['欧码', 'euSize'], ['美码', 'usSize'],
    ['头围', 'head'], ['帽围', 'head'],
    // English (agent-site translations, Google Translate output)
    ['clothing length', 'length'], ['clothes length', 'length'], ['garment length', 'length'], ['body length', 'length'], ['back length', 'length'],
    ['top length', 'length'], ['dress length', 'skirtLength'], ['skirt length', 'skirtLength'], ['total length', 'length'], ['length', 'length'],
    ['bust', 'chest'], ['chest', 'chest'], ['chest circumference', 'chest'], ['bust circumference', 'chest'],
    ['chest width', 'chest', true], ['bust width', 'chest', true], ['half chest', 'chest', true], ['pit to pit', 'chest', true], ['p2p', 'chest', true],
    ['shoulder width', 'shoulder'], ['shoulders', 'shoulder'], ['shoulder', 'shoulder'],
    ['sleeve length', 'sleeve'], ['sleeves', 'sleeve'], ['sleeve', 'sleeve'],
    ['waistline', 'waist'], ['waist circumference', 'waist'], ['waist', 'waist'], ['waist width', 'waist', true], ['half waist', 'waist', true],
    ['hipline', 'hip'], ['hips', 'hip'], ['hip', 'hip'], ['hip width', 'hip', true], ['half hip', 'hip', true],
    ['hem width', 'hem', true], ['hem', 'hem'],
    ['cuff', 'cuff'], ['neck', 'neck'], ['collar', 'neck'],
    ['pants length', 'outseam'], ['pant length', 'outseam'], ['trousers length', 'outseam'], ['trouser length', 'outseam'], ['outseam', 'outseam'],
    ['inseam', 'inseam'], ['inside leg', 'inseam'], ['inner length', 'inseam'],
    ['front rise', 'rise'], ['rise', 'rise'], ['back rise', 'backRise'], ['crotch', 'rise'],
    ['thigh circumference', 'thigh'], ['thigh', 'thigh'], ['thigh width', 'thigh', true], ['leg width', 'thigh', true],
    ['knee', 'knee'], ['leg opening', 'legOpening'], ['foot opening', 'legOpening'], ['trouser leg', 'legOpening'],
    ['height', 'height'], ['weight', 'weight'], ['foot length', 'footLength'], ['insole', 'insole'], ['eu', 'euSize'], ['euro', 'euSize'],
    ['head circumference', 'head'], ['head', 'head'],
  ];

  // Words that label the size column/row.
  const SIZE_HEADER_WORDS = ['尺码', '尺寸', '码数', '码号', '型号', '规格', '号型', '鞋码', '尺碼', '码', 'size', 'sizes', 'tag size'];

  // Garment-type keywords found in product titles.
  const TYPE_KEYWORDS = [
    ['shoes', ['鞋', '靴', 'sneaker', 'shoe', 'boot', 'slipper', '拖鞋']],
    ['dress', ['连衣裙', '长裙', 'dress', '旗袍']],
    ['skirt', ['半身裙', '短裙', 'skirt']],
    ['shorts', ['短裤', '五分裤', 'shorts']],
    ['pants', ['裤', 'jeans', 'pants', 'trousers', 'joggers', '牛仔裤']],
    ['coat', ['羽绒', '大衣', '风衣', '棉服', '棉衣', 'coat', 'parka', 'down jacket', 'puffer']],
    ['jacket', ['外套', '夹克', '西装', '冲锋衣', 'jacket', 'blazer', 'bomber', '开衫']],
    ['sweater', ['卫衣', '毛衣', '针织', 'hoodie', 'sweater', 'sweatshirt', 'pullover', 'cardigan']],
    ['shirt', ['衬衫', '衬衣', 'polo', 'shirt']],
    ['tee', ['t恤', 'tee', 't-shirt', '短袖', '背心', 'tank']],
  ];

  const GARMENT_TYPES = {
    tee:     { label: 'T-shirt / tank', group: 'top' },
    shirt:   { label: 'Shirt / polo', group: 'top' },
    sweater: { label: 'Hoodie / sweater', group: 'top' },
    jacket:  { label: 'Jacket', group: 'top' },
    coat:    { label: 'Coat / puffer', group: 'top' },
    dress:   { label: 'Dress', group: 'dress' },
    pants:   { label: 'Pants / jeans', group: 'bottom' },
    shorts:  { label: 'Shorts', group: 'bottom' },
    skirt:   { label: 'Skirt', group: 'bottom' },
    shoes:   { label: 'Shoes', group: 'shoes' },
  };

  // ---------------------------------------------------------------------------
  // Text normalisation
  // ---------------------------------------------------------------------------
  const RADICAL_FIX = { '⻓': '长', '⻋': '车', '⻔': '门', '⻅': '见', '⻢': '马', '⻬': '齐', '⻜': '飞', '⻩': '黄' };

  function normalizeText(input) {
    let s = String(input || '');
    try { s = s.normalize('NFKC'); } catch (e) { /* old engines */ }
    s = s.replace(/[⺀-⻿]/g, (c) => RADICAL_FIX[c] || c);
    s = s
      .replace(/[　 ]/g, ' ')
      .replace(/[“”″〃]/g, '"')
      .replace(/[‘’′]/g, "'")
      .replace(/[～〜~]/g, '~')
      .replace(/[—–－‐‑]/g, '-')
      .replace(/[：]/g, ':')
      .replace(/[，、]/g, ',')
      .replace(/[；]/g, ';')
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/[｜¦]/g, '|')
      .replace(/\r\n?/g, '\n');
    // Common OCR confusions of 围 (circumference) after body-part characters.
    s = s.replace(/([胸腰臀腿领头袖摆颈])\s*[国困圈固圉囤园围圆]/g, '$1围');
    // Frequent OCR misreads of chart headings.
    s = s.replace(/[交农衣依]\s*[长K⻓]/g, '衣长').replace(/[户屑眉启扁]\s*宽/g, '肩宽').replace(/[斥尺]\s*[码吗玛妈]/g, '尺码')
      .replace(/袖\s*[K⻓]/g, '袖长').replace(/[裤祷]\s*[K⻓]/g, '裤长').replace(/[臂譬]\s*围/g, (m, o, str) => (str[o - 1] === '袖' ? m : '臀围'));
    // 码 sometimes read as 玛/吗/妈 right after a size.
    s = s.replace(/([0-9a-zA-Z])\s*[玛吗妈犸]/g, '$1码');
    return s;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

  // Build a regex that tolerates spaces OCR inserts between Chinese characters.
  function aliasPattern(alias) {
    if (/[一-鿿]/.test(alias)) {
      return Array.from(alias).map(escapeRe).join('\\s*');
    }
    return '\\b' + alias.split(/\s+/).map(escapeRe).join('[\\s_-]*') + '\\b';
  }

  const SORTED_ALIASES = ALIASES.slice().sort((a, b) => b[0].length - a[0].length);
  const MEASURE_RE = new RegExp(SORTED_ALIASES.map((a) => '(' + aliasPattern(a[0]) + ')').join('|'), 'gi');
  const SIZE_HEADER_RE = new RegExp('^(?:' + SIZE_HEADER_WORDS.slice().sort((a, b) => b.length - a.length).map(aliasPattern).join('|') + ')', 'i');

  // Letter sizes: XS..8XL, plus "均码"/free size.
  const LETTER_SIZE_SRC = '(?:(?:X\\s?){0,4}S|M|(?:X\\s?){0,5}L|[2-9]\\s?X\\s?L|[2-9]X|FREE\\s?SIZE|FREE|ONE\\s?SIZE|F|OS|均码|大码|加大码|特大码)';
  const LETTER_SIZE_RE = new RegExp('^' + LETTER_SIZE_SRC + '$', 'i');

  function canonicalSize(label) {
    let s = String(label).trim().toUpperCase().replace(/\s+/g, '');
    if (/^(均码|F|FREE|FREESIZE|ONESIZE|OS)$/.test(s)) return 'One size';
    s = s.replace(/[码號号]$/, '');
    const m = s.match(/^(\d)X(L?)$/);
    if (m) s = m[1] + 'XL';
    const x = s.match(/^(X{2,5})L$/);
    if (x) s = (x[1].length) + 'XL';
    if (/^(F|FREE|FREESIZE|ONESIZE|OS|均码)$/.test(s)) s = 'One size';
    return s;
  }

  // ---------------------------------------------------------------------------
  // Tokeniser
  // ---------------------------------------------------------------------------
  // Number with optional range and unit.
  // Single-letter units (m, in, ") must touch the number so "66 M 68" keeps size M.
  const NUM_RE = /(\d+(?:\.\d+)?)(?:\s*(?:-|~|至|到|—)\s*(\d+(?:\.\d+)?))?(?:\s*(cm|厘米|公分|mm|毫米|inches|inch|英寸|寸|斤|kg|公斤|千克|lbs|磅|米|码|號|号)|(in(?![a-z])|"|m(?![a-z])|lb(?![a-z])))?/iy;
  const CHI_FOOT_RE = /(\d)\s*尺\s*(\d(?:\.\d)?)?\s*寸?/y; // 2尺2 (Chinese waist sizes)
  const LETTER_TOKEN_RE = new RegExp('(?:' + LETTER_SIZE_SRC + ')(?:码|号)?(?![a-z])', 'iy');
  const KID_OR_NUM_SIZE_RE = /(\d{2,3})\s*\/\s*(\d{2,3})\s*([ABY])?/y; // 170/88A

  function tokenizeLine(line) {
    const tokens = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
      const ch = line[i];
      if (/\s|[,;:|()\[\]【】<>《》=*·•]/.test(ch)) { i++; continue; }

      // measurement keyword?
      MEASURE_RE.lastIndex = i;
      const mm = MEASURE_RE.exec(line);
      if (mm && mm.index === i) {
        const groupIdx = mm.slice(1).findIndex((g) => g !== undefined);
        const def = SORTED_ALIASES[groupIdx];
        let text = mm[0];
        let half = !!def[2];
        let end = i + text.length;
        // "(平铺)" / "平铺" / "(cm)" right after a keyword
        const tail = line.slice(end).match(/^\s*\(?\s*(平铺|平量|单边|半围|flat|cm|厘米|inch|英寸)\s*\)?/i);
        if (tail) {
          if (/平铺|平量|单边|半围|flat/i.test(tail[1])) half = true;
          end += tail[0].length;
        }
        tokens.push({ type: 'measure', key: def[1], half, text, unitHint: tail && /inch|英寸/i.test(tail[1]) ? 'in' : null });
        i = end;
        continue;
      }

      // size header word ("尺码", "Size")
      const rest = line.slice(i);
      const sh = rest.match(SIZE_HEADER_RE);
      if (sh && !/^码\s*\d/.test(rest)) {
        tokens.push({ type: 'sizeHeader', text: sh[0] });
        i += sh[0].length;
        continue;
      }

      // 170/88A style size
      KID_OR_NUM_SIZE_RE.lastIndex = i;
      const ks = KID_OR_NUM_SIZE_RE.exec(line);
      if (ks && ks.index === i) {
        tokens.push({ type: 'size', label: ks[0].replace(/\s+/g, ''), numeric: Number(ks[1]) });
        i += ks[0].length;
        continue;
      }

      // 2尺2 Chinese waist notation
      CHI_FOOT_RE.lastIndex = i;
      const cf = CHI_FOOT_RE.exec(line);
      if (cf && cf.index === i) {
        const shicun = Number(cf[1]) * 10 + (cf[2] ? Number(cf[2]) : 0);
        tokens.push({ type: 'num', value: shicun, unit: 'shicun', raw: cf[0] });
        i += cf[0].length;
        continue;
      }

      // "2XL" / "3X" must win over the number 2
      if (/\d/.test(ch) && /^\d\s?X/i.test(rest)) {
        LETTER_TOKEN_RE.lastIndex = i;
        const ls2 = LETTER_TOKEN_RE.exec(line);
        if (ls2 && ls2.index === i) {
          tokens.push({ type: 'size', label: canonicalSize(ls2[0]), explicit: /码|号/.test(ls2[0]) });
          i += ls2[0].length;
          continue;
        }
      }

      // number
      if (/\d/.test(ch)) {
        NUM_RE.lastIndex = i;
        const nm = NUM_RE.exec(line);
        if (nm && nm.index === i) {
          const unitRaw = (nm[3] || nm[4] || '').toLowerCase();
          if (unitRaw === '码' || unitRaw === '号' || unitRaw === '號') {
            tokens.push({ type: 'size', label: nm[1], numeric: Number(nm[1]), explicit: true });
          } else {
            const tok = { type: 'num', value: Number(nm[1]), raw: nm[0].trim() };
            if (nm[2] !== undefined) tok.max = Number(nm[2]);
            if (unitRaw) tok.unit = unitRaw;
            tokens.push(tok);
          }
          i += nm[0].length;
          continue;
        }
      }

      // letter size (S, M, XL, 2XL, 均码 ...)
      LETTER_TOKEN_RE.lastIndex = i;
      const ls = LETTER_TOKEN_RE.exec(line);
      if (ls && ls.index === i && (i === 0 || !/[a-z]/i.test(line[i - 1]))) {
        tokens.push({ type: 'size', label: canonicalSize(ls[0]), explicit: /码|号/.test(ls[0]) });
        i += ls[0].length;
        continue;
      }

      // unit declarations
      const ud = rest.match(/^单位\s*:?\s*(cm|厘米|公分|inch|英寸|in)/i);
      if (ud) {
        tokens.push({ type: 'unitDecl', unit: /inch|英寸|^in$/i.test(ud[1]) ? 'in' : 'cm' });
        i += ud[0].length;
        continue;
      }

      // other word
      const w = rest.match(/^([a-z]+|[一-鿿]|.)/i);
      tokens.push({ type: 'word', text: w[0] });
      i += w[0].length;
    }
    return tokens;
  }

  // ---------------------------------------------------------------------------
  // Value conversion
  // ---------------------------------------------------------------------------
  function convertValue(tok, key, defaultUnit) {
    const def = MEASURE_DEFS[key] || { kind: 'len' };
    let unit = tok.unit || '';
    let min = tok.value;
    let max = tok.max != null ? tok.max : tok.value;
    let factor = 1;

    if (def.kind === 'weight') {
      if (/^(kg|公斤|千克)$/.test(unit)) factor = 1;
      else if (/^(lb|lbs|磅)$/.test(unit)) factor = KG_PER_LB;
      else if (unit === '斤') factor = KG_PER_JIN;
      else factor = min >= 75 ? KG_PER_JIN : 1; // Taobao default is 斤 (90-200); kg values are usually < 75... ambiguous, prefer 斤 when large
      return { min: min * factor, max: max * factor, unitIn: unit || (factor === 1 ? 'kg?' : '斤?') };
    }
    if (def.kind === 'height') {
      if (unit === 'm' || unit === '米' || min < 3) factor = 100;
      else if (unit === 'in' || unit === 'inch' || unit === 'inches' || unit === '"') factor = CM_PER_IN;
      return { min: min * factor, max: max * factor };
    }
    if (def.kind === 'shoesize') {
      return { min, max };
    }
    if (def.kind === 'foot') {
      if (unit === 'mm' || unit === '毫米' || (!unit && min > 100)) factor = 0.1;
      else if (unit === 'in' || unit === 'inch' || unit === '"') factor = CM_PER_IN;
      return { min: min * factor, max: max * factor };
    }
    // lengths / circumferences
    if (unit === 'shicun' || unit === '寸') factor = CM_PER_SHICUN;
    else if (unit === 'mm' || unit === '毫米') factor = 0.1;
    else if (unit === 'in' || unit === 'inch' || unit === 'inches' || unit === '英寸' || unit === '"') factor = CM_PER_IN;
    else if (unit === 'm' || unit === '米') factor = min < 3 ? 100 : 1;
    else if (!unit && defaultUnit === 'in') factor = CM_PER_IN;
    return { min: min * factor, max: max * factor };
  }

  // ---------------------------------------------------------------------------
  // Chart parsing
  // ---------------------------------------------------------------------------
  function sizeFromToken(tok) {
    if (tok.type === 'size') return tok.label;
    if (tok.type === 'num' && tok.max == null && !tok.unit) return String(tok.value);
    return null;
  }

  function isValueToken(t) { return t.type === 'num'; }

  // Typical column orders on Taobao/1688 charts and plausible cm ranges.
  const COLUMN_TEMPLATES = [
    ['length', 'chest', 'shoulder', 'sleeve', 'hem'],
    ['length', 'shoulder', 'chest', 'sleeve'],
    ['shoulder', 'chest', 'length', 'sleeve'],
    ['chest', 'length', 'shoulder', 'sleeve'],
    ['chest', 'shoulder', 'length', 'sleeve'],
    ['length', 'chest', 'sleeve'],
    ['waist', 'hip', 'outseam', 'thigh', 'legOpening'],
    ['outseam', 'waist', 'hip', 'thigh', 'legOpening'],
    ['waist', 'outseam', 'hip', 'thigh', 'legOpening'],
    ['waist', 'hip', 'thigh', 'outseam', 'legOpening'],
    ['waist', 'outseam', 'legOpening'],
    ['length', 'chest', 'waist', 'hip'],
  ];
  const PLAUSIBLE = {
    length: [[50, 95]], chest: [[80, 160], [40, 78]], shoulder: [[36, 68]], sleeve: [[15, 32], [48, 72]], hem: [[80, 160], [40, 78]],
    waist: [[56, 115], [28, 56]], hip: [[84, 135], [42, 66]], outseam: [[85, 118], [36, 62]], thigh: [[48, 82], [24, 41]], legOpening: [[28, 52], [13, 26]],
  };

  function guessColumns(rows, n, hints) {
    hints = hints || [];
    const keys = new Array(n).fill(null);
    const free = [];
    for (let c = 0; c < n; c++) {
      const tok = rows[0].nums[c];
      const unit = tok.unit || '';
      const firsts = rows.map((r) => r.nums[c] && r.nums[c].value).filter((x) => x != null);
      const step = firsts.length > 1 ? (firsts[firsts.length - 1] - firsts[0]) / (firsts.length - 1) : 0;
      if (/斤|kg|公斤|lb/.test(unit) || (tok.max != null && tok.value >= 70 && tok.value < 150 && step >= 8 && !/cm/.test(unit))) keys[c] = 'weight';
      else if (tok.max != null && tok.value >= 145 && tok.value <= 200) keys[c] = 'height';
      else free.push(c);
    }
    const med = (c) => median(rows.map((r) => r.nums[c] && r.nums[c].value));
    let bestT = null, bestScore = -1;
    COLUMN_TEMPLATES.forEach((tpl) => {
      if (tpl.length < free.length) return;
      let score = 0;
      free.forEach((c, i) => {
        const m = med(c);
        if ((PLAUSIBLE[tpl[i]] || []).some(([lo, hi]) => m >= lo && m <= hi)) score++;
      });
      // Prefer layouts that agree with the column names we could read, in order.
      const used = free.map((c, i) => tpl[i]);
      const hinted = hints.filter((h) => used.includes(h) || keys.includes(h));
      score += hinted.length * 0.6;
      let lastPos = -1, ordered = true;
      hints.filter((h) => used.includes(h)).forEach((h) => { const pos = used.indexOf(h); if (pos < lastPos) ordered = false; lastPos = pos; });
      if (ordered) score += 0.3;
      score -= (tpl.length - free.length) * 0.01;
      if (score > bestScore) { bestScore = score; bestT = tpl; }
    });
    free.forEach((c, i) => { keys[c] = bestT ? bestT[i] : null; });
    return keys;
  }

  // Partition split digit tokens into `count` numbers, closest to `ref` values.
  function regroupDigits(tokens, count, ref) {
    if (tokens.some((t) => t.max != null || t.unit)) return null;
    const parts = tokens.map((t) => t.raw.replace(/\s+/g, ''));
    const n = parts.length;
    if (n > 24 || count < 1) return null;
    const cost = (str, k) => {
      const v = Number(str);
      if (!isFinite(v) || str.length > 4 || (str.length > 1 && str[0] === '0')) return Infinity;
      if (ref && ref[k] != null) return Math.pow((v - ref[k]) / Math.max(ref[k], 1), 2);
      return str.length >= 2 && str.length <= 3 ? 0 : 1;
    };
    // dp[i][k] = best cost using first i parts for k numbers
    const dp = Array.from({ length: n + 1 }, () => Array(count + 1).fill(Infinity));
    const back = Array.from({ length: n + 1 }, () => Array(count + 1).fill(-1));
    dp[0][0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let k = 1; k <= count; k++) {
        for (let j = k - 1; j < i; j++) {
          if (dp[j][k - 1] === Infinity) continue;
          const c = dp[j][k - 1] + cost(parts.slice(j, i).join(''), k - 1);
          if (c < dp[i][k]) { dp[i][k] = c; back[i][k] = j; }
        }
      }
    }
    if (dp[n][count] === Infinity || (ref && dp[n][count] > 0.05 * count)) return null;
    const out = [];
    for (let i = n, k = count; k > 0; k--) {
      const j = back[i][k];
      const str = parts.slice(j, i).join('');
      out.unshift({ type: 'num', value: Number(str), raw: str });
      i = j;
    }
    return out;
  }

  /**
   * Parse free text (pasted from a product page, an agent site, or OCR output).
   * Returns { sizes: [{label, values: {key: {min,max}}}], columns: [key...], flags, warnings }.
   */
  function parseChart(text, opts) {
    opts = opts || {};
    const norm = normalizeText(text);
    const lines = norm.split('\n').map((l) => l.trim()).filter(Boolean);
    const tokLines = lines.map((l) => ({ line: l, tokens: tokenizeLine(l) }));

    let defaultUnit = opts.unit || null;
    if (!defaultUnit) {
      for (const tl of tokLines) {
        const ud = tl.tokens.find((t) => t.type === 'unitDecl');
        if (ud) { defaultUnit = ud.unit; break; }
      }
      if (!defaultUnit && /\(\s*(inch|inches|英寸)\s*\)|单位\s*:?\s*(inch|英寸)/i.test(norm)) defaultUnit = 'in';
      if (!defaultUnit) defaultUnit = 'cm';
    }

    const sizes = new Map(); // label -> {label, values}
    const order = [];
    const halfKeys = new Set();
    const warnings = [];
    const sourceNotes = [];

    function put(label, key, tok, half, unitHint) {
      if (!label) return;
      label = canonicalSize(label);
      if (!sizes.has(label)) { sizes.set(label, { label, values: {} }); order.push(label); }
      const s = sizes.get(label);
      if (s.values[key]) return; // first occurrence wins
      const v = convertValue(tok, key, unitHint || defaultUnit);
      v.raw = tok.raw;
      s.values[key] = v;
      if (half) halfKeys.add(key);
    }

    // --- Pass 1: header row + size rows ---------------------------------
    for (let li = 0; li < tokLines.length; li++) {
      const head = tokLines[li].tokens;
      const measures = head.filter((t) => t.type === 'measure');
      const hasValues = head.some(isValueToken);
      if (measures.length < 2 || hasValues) continue;
      // Merge a header that OCR split over two lines.
      let header = head.slice();
      let next = li + 1;
      while (next < tokLines.length) {
        const t2 = tokLines[next].tokens;
        if (t2.length && t2.every((t) => t.type === 'measure' || t.type === 'word' || t.type === 'sizeHeader')
            && t2.some((t) => t.type === 'measure')) { header = header.concat(t2); next++; } else break;
      }
      const cols = header.filter((t) => t.type === 'measure' || t.type === 'sizeHeader');
      const measureCols = cols.filter((t) => t.type === 'measure');
      const sizeColFirst = cols.length && cols[0].type === 'sizeHeader';
      const rows = [];
      let r = next;
      for (; r < tokLines.length; r++) {
        const toks = tokLines[r].tokens.filter((t) => t.type !== 'word' || !/^[,.;:|]$/.test(t.text));
        if (toks.some((t) => t.type === 'measure') && toks.filter((t) => t.type === 'measure').length >= 2 && !toks.some((t) => t.type === 'size')) break; // a new header
        const vals = toks.filter((t) => t.type === 'num' || t.type === 'size');
        if (vals.length < 2) { if (rows.length) break; else continue; }
        let label = null;
        let values;
        if (vals[0].type === 'size') { label = vals[0].label; values = vals.slice(1); }
        else if (sizeColFirst || vals.length > measureCols.length) { label = sizeFromToken(vals[0]); values = vals.slice(1); }
        else { label = 'Size ' + (rows.length + 1); values = vals; }
        values = values.filter((t) => t.type === 'num');
        if (!label || !values.length) continue;
        rows.push({ label, values });
      }
      // Header partly unreadable: rows consistently have more numbers than named columns.
      let colKeys = measureCols.map((mc) => mc.key);
      const wider = rows.filter((row) => row.values.length > measureCols.length);
      if (rows.length >= 2 && wider.length >= Math.ceil(rows.length * 0.6)) {
        const n = median(wider.map((row) => row.values.length));
        const same = rows.filter((row) => row.values.length === n);
        if (same.length >= 2) {
          colKeys = guessColumns(same.map((row) => ({ nums: row.values })), n, colKeys);
          measureCols.length = 0;
          colKeys.forEach((k) => measureCols.push({ key: k, half: (head.find((t) => t.key === k) || {}).half }));
          warnings.push('Some column names could not be read, so they were guessed from the numbers. Check the column headings in the table below.');
        }
      }
      // OCR often splits "66 100" into "6 6 1 0 0": regroup using a clean neighbouring row.
      rows.forEach((row, idx) => {
        if (row.values.length <= measureCols.length) return;
        const ref = rows.slice(idx + 1).concat(rows.slice(0, idx).reverse()).find((x) => x.values.length === measureCols.length);
        const fixed = regroupDigits(row.values, measureCols.length, ref && ref.values.map((t) => t.value));
        if (fixed) { row.values = fixed; row.repaired = true; }
      });
      rows.forEach((row) => {
        measureCols.forEach((mc, ci) => {
          if (mc.key && row.values[ci]) put(row.label, mc.key, row.values[ci], mc.half, mc.unitHint);
        });
        if (row.repaired) warnings.push(`Row "${canonicalSize(row.label)}" looked garbled (split digits) and was repaired — double-check it below.`);
        else if (row.values.length !== measureCols.length) {
          warnings.push(`Row "${canonicalSize(row.label)}" has ${row.values.length} numbers for ${measureCols.length} columns — check it in the table below.`);
        }
      });
      if (rows.length) { sourceNotes.push('table (sizes in rows)'); li = r - 1; }
    }

    // --- Pass 2: transposed (one line per measurement, sizes across) -----
    if (!sizes.size) {
      let sizeRow = null;
      for (const tl of tokLines) {
        const t = tl.tokens;
        const sizeToks = t.filter((x) => x.type === 'size');
        const startsWithHeader = t[0] && t[0].type === 'sizeHeader';
        if ((sizeToks.length >= 2 && !t.some((x) => x.type === 'measure')) || (startsWithHeader && t.length >= 3 && !t.some((x) => x.type === 'measure'))) {
          sizeRow = t.filter((x) => x.type === 'size' || (startsWithHeader && x.type === 'num')).map((x) => sizeFromToken(x) || x.label);
          continue;
        }
        if (t[0] && t[0].type === 'measure') {
          const nums = t.filter((x) => x.type === 'num');
          const sizeInline = t.filter((x) => x.type === 'size');
          // "胸围: S 100 M 104 L 108"
          if (sizeInline.length >= 2) {
            for (let k = 1; k < t.length; k++) {
              if (t[k].type === 'size' && t[k + 1] && t[k + 1].type === 'num') put(t[k].label, t[0].key, t[k + 1], t[0].half, t[0].unitHint);
            }
            continue;
          }
          if (nums.length >= 2 && sizeRow) {
            nums.forEach((nTok, idx) => { if (sizeRow[idx]) put(sizeRow[idx], t[0].key, nTok, t[0].half, t[0].unitHint); });
            if (nums.length !== sizeRow.length) warnings.push(`"${t[0].text}" has ${nums.length} values for ${sizeRow.length} sizes — check it below.`);
          } else if (nums.length >= 2 && !sizeRow) {
            nums.forEach((nTok, idx) => put('Size ' + (idx + 1), t[0].key, nTok, t[0].half, t[0].unitHint));
          }
        }
      }
      if (sizes.size) sourceNotes.push('table (sizes in columns)');
    }

    // --- Pass 3: inline "S码: 衣长68 胸围104 ..." / one-size descriptions --
    if (!sizes.size || opts.mergeInline) {
      let current = null;
      for (const tl of tokLines) {
        const t = tl.tokens;
        for (let k = 0; k < t.length; k++) {
          const tok = t[k];
          if (tok.type === 'size' && (tok.explicit || LETTER_SIZE_RE.test(tok.label) || /^\d+\/\d+/.test(tok.label) || /^One size$/i.test(tok.label) || (t[k + 1] && t[k + 1].type === 'measure'))) {
            current = tok.label;
          } else if (tok.type === 'sizeHeader' && t[k + 1] && (t[k + 1].type === 'num' || t[k + 1].type === 'size')) {
            current = sizeFromToken(t[k + 1]) || t[k + 1].label; k++;
          } else if (tok.type === 'measure') {
            // value is the next number (allow one filler word like 约)
            let j = k + 1;
            while (j < t.length && t[j].type === 'word' && j - k <= 2) j++;
            if (t[j] && t[j].type === 'num') {
              put(current || 'One size', tok.key, t[j], tok.half, tok.unitHint);
              k = j;
            }
          }
        }
      }
      if (sizes.size) sourceNotes.push('inline text');
    }

    // --- Pass 4: rows of numbers whose header was unreadable (common with OCR
    // of white-on-colour header rows): guess the columns from typical layouts.
    let guessed = false;
    if (!sizes.size) {
      const rows = [];
      tokLines.forEach((tl) => {
        const t = tl.tokens;
        if (!t.length || t[0].type !== 'size') return;
        const nums = t.slice(1).filter((x) => x.type === 'num');
        if (nums.length >= 2) rows.push({ label: t[0].label, nums });
      });
      const counts = {};
      rows.forEach((r) => { counts[r.nums.length] = (counts[r.nums.length] || 0) + 1; });
      const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      if (rows.length >= 2 && best) {
        const n = Number(best);
        const good = rows.filter((r) => r.nums.length === n);
        const keys = guessColumns(good, n);
        rows.forEach((r) => {
          const vals = r.nums.length > n ? (regroupDigits(r.nums, n, good[0].nums.map((x) => x.value)) || r.nums) : r.nums;
          keys.forEach((k, ci) => { if (k && vals[ci]) put(r.label, k, vals[ci], false); });
        });
        guessed = true;
        warnings.push('The column names could not be read, so they were guessed from the numbers. Check the column headings in the table below and change any that are wrong.');
        sourceNotes.push('rows of numbers (column names guessed)');
      }
    }

    const chart = {
      guessed,
      sizes: order.map((l) => sizes.get(l)),
      halfKeys: Array.from(halfKeys),
      defaultUnit,
      warnings,
      source: sourceNotes.join(', '),
    };
    chart.sizes = chart.sizes.filter((s) => Object.keys(s.values).length > 0);
    return chart;
  }

  // ---------------------------------------------------------------------------
  // Post-processing: decide garment type, remap ambiguous keys, flat → full
  // ---------------------------------------------------------------------------
  function detectType(chart, title) {
    const t = String(title || '').toLowerCase();
    if (t) {
      for (const [type, words] of TYPE_KEYWORDS) {
        if (words.some((w) => t.includes(w))) {
          // "短袖" + 裤 etc: prefer bottoms if chart looks like bottoms
          return refineTypeByChart(type, chart);
        }
      }
    }
    return refineTypeByChart(null, chart);
  }

  function chartKeys(chart) {
    const keys = new Set();
    chart.sizes.forEach((s) => Object.keys(s.values).forEach((k) => keys.add(k)));
    return keys;
  }

  function median(arr) {
    const a = arr.filter((v) => v != null && isFinite(v)).slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function colMedian(chart, key) {
    return median(chart.sizes.map((s) => s.values[key] && (s.values[key].min + s.values[key].max) / 2));
  }

  function refineTypeByChart(type, chart) {
    const keys = chartKeys(chart);
    const has = (k) => keys.has(k);
    const isShoes = has('footLength') || has('insole') || has('euSize') ||
      (!keys.size ? false : chart.sizes.every((s) => /^(3[3-9]|4[0-9])(\.5)?$/.test(s.label) || /^(2[1-9]\d|30\d)$/.test(s.label)) && !has('waist') && !has('chest') && !has('hip'));
    if (type === 'shoes' || isShoes) return 'shoes';
    const bottomish = has('outseam') || has('inseam') || has('rise') || has('thigh') || has('legOpening');
    const topish = has('chest') || has('shoulder') || has('sleeve') || has('fullSleeve');
    if (type && GARMENT_TYPES[type]) {
      const g = GARMENT_TYPES[type].group;
      if (g === 'top' && bottomish && !topish) return 'pants';
      if (g === 'bottom' && topish && !bottomish) return 'tee';
      return type;
    }
    if (bottomish && !topish) {
      const len = colMedian(chart, 'outseam') || colMedian(chart, 'length');
      return len && len < 65 ? 'shorts' : 'pants';
    }
    if (has('skirtLength') && !topish) return 'skirt';
    if (topish) {
      const len = colMedian(chart, 'length') || colMedian(chart, 'skirtLength');
      if (len && len > 95 && (has('waist') || has('hip') || has('skirtLength'))) return 'dress';
      const sl = colMedian(chart, 'sleeve');
      if (sl && sl < 30) return 'tee';
      if (len && len > 85) return 'coat';
      return sl ? 'sweater' : 'tee';
    }
    if (has('waist') && has('hip') && has('length')) return 'pants';
    return 'tee';
  }

  // Values that are clearly half (flat-lay) measurements for an adult garment.
  const HALF_THRESHOLDS = { chest: 72, waist: 48, hip: 60, thigh: 38, hem: 62, bicep: 24, cuff: 14, legOpening: 26, knee: 28 };

  /**
   * Normalise a parsed chart for a garment type. Returns a new chart with
   * values in full circumference, cm, and a list of human-readable notes.
   */
  function normalizeChart(chart, type, overrides) {
    overrides = overrides || {};
    const out = JSON.parse(JSON.stringify(chart));
    out.type = type;
    out.notes = [];
    const group = (GARMENT_TYPES[type] || {}).group;

    out.sizes.forEach((s) => {
      const v = s.values;
      // Ambiguous "length" in bottoms = outseam; in skirts/dresses = skirt length
      if (group === 'bottom' && v.length && !v.outseam && type !== 'skirt') { v.outseam = v.length; delete v.length; }
      if ((type === 'skirt') && v.length && !v.skirtLength) { v.skirtLength = v.length; delete v.length; }
      if (type === 'dress' && v.skirtLength && !v.length) { v.length = v.skirtLength; delete v.skirtLength; }
      if (type === 'shoes' && v.inseam && !v.insole) { v.insole = v.inseam; delete v.inseam; }
    });
    if (group === 'bottom' && chart.halfKeys.includes('length')) out.halfKeys = out.halfKeys.filter((k) => k !== 'length');

    // Flat ("平铺") values → full circumference
    const keys = chartKeys(out);
    out.doubled = [];
    keys.forEach((key) => {
      const def = MEASURE_DEFS[key];
      if (!def || def.kind !== 'circ') return;
      let half = out.halfKeys.includes(key);
      const med = colMedian(out, key);
      if (!half && HALF_THRESHOLDS[key] && med != null && med < HALF_THRESHOLDS[key] && type !== 'shoes') {
        half = true;
        out.notes.push(`${def.zh} (${def.label}) values look like flat-lay half measurements, so they were doubled.`);
      }
      if (overrides[key] === 'full') half = false;
      if (overrides[key] === 'half') half = true;
      if (half) {
        out.doubled.push(key);
        out.sizes.forEach((s) => {
          const val = s.values[key];
          if (val) { val.min *= 2; val.max *= 2; val.doubled = true; }
        });
      }
    });
    if (out.doubled.length && chart.halfKeys.length) {
      out.notes.push('Chart marks some measurements as 平铺 (flat-lay); they were doubled to full circumference.');
    }

    // Shoes: derive foot length from labels when the chart has no foot length.
    if (type === 'shoes') {
      out.sizes.forEach((s) => {
        const v = s.values;
        const num = parseFloat(s.label);
        if (!v.euSize && num >= 33 && num <= 49) v.euSize = { min: num, max: num };
        if (!v.footLength && num >= 210 && num <= 310) v.footLength = { min: num / 10, max: num / 10 };
      });
    }

    // Sanity check: values should grow with size.
    keys.forEach((key) => {
      if (['height', 'weight'].includes(key)) return;
      const vals = out.sizes.map((s) => s.values[key] && (s.values[key].min + s.values[key].max) / 2);
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] != null && vals[i - 1] != null && vals[i] < vals[i - 1] - 0.5) {
          out.notes.push(`Check ${MEASURE_DEFS[key] ? MEASURE_DEFS[key].zh + ' (' + MEASURE_DEFS[key].label + ')' : key}: ${out.sizes[i].label} is smaller than ${out.sizes[i - 1].label} — possibly a misread number.`);
          break;
        }
      }
    });

    // Elastic waist: a range like 66-90 or the words 松紧/弹力
    out.sizes.forEach((s) => {
      const w = s.values.waist;
      if (w && w.max - w.min >= 6) w.elastic = true;
    });
    return out;
  }

  function mid(v) { return v == null ? null : (v.min + v.max) / 2; }

  // ---------------------------------------------------------------------------
  // Body model
  // ---------------------------------------------------------------------------
  /**
   * profile (cm/kg): height, weight, chest, waist, pantWaist, hip, shoulder,
   * armLength, neck, inseam, outseam, thigh, bicep, footLength, footWidth,
   * head, figure ('masculine'|'feminine'), fitTop, fitBottom.
   */
  function buildBody(profile) {
    const p = Object.assign({}, profile);
    const H = p.height || 175;
    const fem = p.figure === 'feminine';
    const est = {};
    function need(key, value) { if (p[key] == null || !(p[key] > 0)) { p[key] = value; est[key] = true; } }
    need('chest', fem ? 0.52 * H + 3 : 0.55 * H + 2);
    need('waist', fem ? 0.4 * H + 4 : 0.47 * H);
    need('hip', fem ? 0.57 * H + 4 : 0.54 * H + 3);
    need('shoulder', fem ? 0.235 * H : 0.258 * H);
    need('armLength', 0.335 * H);
    need('neck', fem ? 0.2 * H : 0.215 * H);
    need('inseam', 0.45 * H);
    need('pantWaist', p.waist + (fem ? 4 : 1));
    need('outseam', p.inseam + 0.155 * H);
    need('thigh', 0.58 * p.hip);
    need('bicep', 0.3 * p.chest);
    need('footLength', 0.152 * H);

    const L = {
      floor: 0,
      top: H,
      chin: 0.868 * H,
      hps: 0.843 * H, // high point shoulder (base of neck)
      shoulder: 0.815 * H,
      armpit: 0.745 * H,
      chest: 0.72 * H,
      waist: 0.615 * H,
      pantWaist: Math.min(p.outseam, 0.62 * H),
      hip: Math.max(p.inseam + 0.06 * H, 0.49 * H),
      crotch: p.inseam,
      knee: 0.285 * H,
      calf: 0.2 * H,
      ankle: 0.045 * H,
    };
    L.midThigh = (L.crotch + L.knee) / 2;
    if (L.pantWaist < L.hip + 3) L.pantWaist = L.hip + 3;
    return { p, H, L, est, fem };
  }

  // Body circumference at a given height (for hems landing between landmarks)
  function bodyCircAt(body, y) {
    const { p, L } = body;
    const pts = [
      [L.armpit, p.chest], [L.chest, p.chest], [L.waist, p.waist], [L.pantWaist, p.pantWaist], [L.hip, p.hip], [L.crotch, p.hip * 0.98],
    ];
    if (y >= pts[0][0]) return p.chest;
    for (let i = 0; i < pts.length - 1; i++) {
      const [y1, c1] = pts[i];
      const [y2, c2] = pts[i + 1];
      if (y <= y1 && y >= y2) return c1 + ((y1 - y) / (y1 - y2 || 1)) * (c2 - c1);
    }
    return p.thigh * 2; // below crotch a top wraps both legs
  }

  // Where does a hem at height y land on the body?
  function describeHeight(body, y, kind) {
    const { L } = body;
    const near = (a, tol) => Math.abs(y - a) <= tol;
    if (kind === 'bottom') {
      if (y < -1) return `${fmtSigned(-y)} past the floor (will stack/puddle — can be hemmed)`;
      if (y <= 3) return 'at the floor / covers your shoes';
      if (y <= 7) return 'at the top of your foot (full length)';
      if (y <= 12) return 'at the ankle (ankle-length, 九分裤 style)';
      if (y <= L.calf) return 'above the ankle (cropped)';
      if (y <= L.knee - 6) return 'mid-calf';
      if (near(L.knee, 6)) return 'at the knee';
      if (y < L.midThigh) return 'above the knee';
      return 'at mid-thigh or higher';
    }
    if (y > L.waist + 4) return 'above your waist (cropped)';
    if (y > L.pantWaist) return 'at your natural waist';
    if (y > L.hip + 2) return 'at your belt line / high hip';
    if (y > L.crotch + 3) return 'at mid-hip';
    if (near(L.crotch, 3)) return 'at crotch level';
    if (y > L.midThigh) return 'at the upper thigh';
    if (y > L.knee + 6) return 'at mid-thigh';
    if (near(L.knee, 6)) return 'at the knee';
    if (y > L.calf) return 'below the knee';
    if (y > L.ankle + 6) return 'at mid-calf';
    return 'at the ankle';
  }

  function fmtSigned(cm, units) {
    const s = cm >= 0 ? '+' : '−';
    return s + fmtLen(Math.abs(cm), units || 'cm');
  }

  // ---------------------------------------------------------------------------
  // Fit rules
  // ---------------------------------------------------------------------------
  // Ease (garment − body, cm) bands per garment type for each fit preference.
  const EASE = {
    chest: {
      tee:     { slim: [4, 8], regular: [8, 16], relaxed: [16, 26], oversized: [26, 46] },
      shirt:   { slim: [6, 10], regular: [10, 18], relaxed: [18, 28], oversized: [28, 46] },
      sweater: { slim: [6, 12], regular: [12, 22], relaxed: [22, 32], oversized: [32, 52] },
      jacket:  { slim: [10, 16], regular: [16, 24], relaxed: [24, 34], oversized: [34, 56] },
      coat:    { slim: [14, 20], regular: [20, 30], relaxed: [30, 40], oversized: [40, 62] },
      dress:   { slim: [2, 6], regular: [6, 12], relaxed: [12, 24], oversized: [24, 44] },
    },
    shoulder: { slim: [-1.5, 1.5], regular: [-1, 3], relaxed: [0, 6], oversized: [3, 16] },
    waistBottom: { slim: [-1, 2], regular: [0, 3], relaxed: [1, 5], oversized: [2, 8] },
    waistDress: { slim: [1, 4], regular: [3, 8], relaxed: [8, 18], oversized: [14, 40] },
    hip: { slim: [0, 6], regular: [4, 10], relaxed: [8, 18], oversized: [14, 36] },
    hipDress: { slim: [2, 6], regular: [5, 12], relaxed: [10, 24], oversized: [20, 50] },
    thigh: { slim: [2, 7], regular: [5, 12], relaxed: [10, 20], oversized: [16, 40] },
  };
  const FIT_ORDER = ['slim', 'regular', 'relaxed', 'oversized'];
  const FIT_NAMES = { slim: 'slim', regular: 'regular', relaxed: 'relaxed', oversized: 'oversized/baggy' };

  function easeLabel(bands, ease, stretch) {
    const lowest = bands.slim[0] - (stretch ? 4 : 0);
    if (ease < lowest - 2) return { status: 'tight', text: 'too tight' };
    if (ease < lowest) return { status: 'snug', text: 'snug' };
    for (const f of FIT_ORDER) {
      if (ease <= bands[f][1]) return { status: 'ok', text: FIT_NAMES[f] + ' fit', band: f };
    }
    if (ease <= bands.oversized[1] + 10) return { status: 'loose', text: 'very loose' };
    return { status: 'big', text: 'too big' };
  }

  // Penalty for a value outside [lo, hi]; tight side is punished harder.
  function rangePenalty(v, lo, hi, tolLow, tolHigh) {
    if (v < lo) return Math.pow((lo - v) / tolLow, 2);
    if (v > hi) return Math.pow((v - hi) / tolHigh, 2);
    // small pull toward the middle so we pick the best size inside the band
    const c = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2, 0.5);
    return 0.15 * Math.pow((v - c) / half, 2);
  }

  // Ideal hem heights (from floor) for tops, by type and fit preference.
  function topHemTarget(body, type, fit) {
    const { L } = body;
    const lowHip = (L.hip + L.crotch) / 2;
    switch (type) {
      case 'coat': return null; // coats come in all lengths: describe only
      case 'jacket': return { lo: L.crotch - 2, hi: L.hip + 4, target: lowHip };
      case 'dress': return null;
      default: {
        if (fit === 'oversized') return { lo: L.crotch - 10, hi: L.hip, target: L.crotch - 2 };
        if (fit === 'slim') return { lo: L.crotch + 1, hi: L.pantWaist - 5, target: L.hip };
        return { lo: L.crotch - 3, hi: L.pantWaist - 5, target: lowHip };
      }
    }
  }

  function hemHeightTop(body, lengthCm) {
    // Chinese 衣长 is measured from the high point shoulder; ~2 cm is lost to the body contour.
    return body.L.hps - lengthCm + 2;
  }

  /**
   * Evaluate one size. Returns {label, score (0-100), penalty, items: [...], render: {...}}
   */
  function evaluateSize(size, chart, body, opts) {
    opts = opts || {};
    const type = chart.type;
    const group = (GARMENT_TYPES[type] || {}).group;
    const p = body.p;
    const fitTop = opts.fitTop || p.fitTop || 'regular';
    const fitBottom = opts.fitBottom || p.fitBottom || 'regular';
    const stretch = !!opts.stretch;
    const v = size.values;
    const items = [];
    let penalty = 0;
    let weightSum = 0;

    function add(item, pen, weight) {
      items.push(item);
      if (pen != null) { penalty += pen * weight; weightSum += weight; }
    }

    const g = (k) => mid(v[k]);

    if (group === 'top' || group === 'dress') {
      const fit = fitTop;
      if (g('chest') != null) {
        const bands = EASE.chest[type] || EASE.chest.tee;
        const ease = g('chest') - p.chest;
        const lab = easeLabel(bands, ease, stretch);
        const [lo, hi] = bands[fit];
        add({ key: 'chest', garment: g('chest'), body: p.chest, diff: ease, status: lab.status, verdict: lab.text, ideal: [lo, hi], kind: 'ease' },
          rangePenalty(ease, lo, hi, 3, 7), 3);
      }
      if (g('shoulder') != null) {
        const diff = g('shoulder') - p.shoulder;
        // A chart whose smallest size already has a much wider shoulder than you is a
        // drop-shoulder design; judge it against the oversized band instead.
        const minShoulder = Math.min.apply(null, chart.sizes.map((s) => mid(s.values.shoulder)).filter((x) => x != null));
        const dropDesign = minShoulder - p.shoulder > 5;
        const [lo, hi] = dropDesign ? EASE.shoulder.oversized : EASE.shoulder[fit];
        let status = 'ok', verdict = 'fits your shoulders';
        if (diff < -2.5) { status = 'tight'; verdict = 'too narrow — seams pull'; }
        else if (diff < -1) { status = 'snug'; verdict = 'a little narrow'; }
        else if (diff > 18) { status = 'loose'; verdict = 'very dropped shoulder'; }
        else if (diff > 5) { status = 'ok'; verdict = 'drop-shoulder cut (by design)'; }
        else if (diff > 3.5) { status = 'ok'; verdict = 'slightly dropped shoulder'; }
        add({ key: 'shoulder', garment: g('shoulder'), body: p.shoulder, diff, status, verdict, ideal: [lo, hi], kind: 'ease' },
          rangePenalty(diff, lo, hi, 1.5, 6), dropDesign ? 0.6 : 1.6);
      }
      // length
      const len = g('length');
      if (len != null) {
        const hem = hemHeightTop(body, len);
        const where = describeHeight(body, hem, 'top');
        const tgt = topHemTarget(body, type, fit);
        let status = 'ok', pen = null;
        if (tgt) {
          pen = rangePenalty(hem, tgt.lo, tgt.hi, 5, 4);
          if (hem > tgt.hi + 3) status = 'snug';
          else if (hem < tgt.lo - 4) status = 'loose';
        }
        add({ key: 'length', garment: len, hemHeight: hem, status, verdict: 'ends ' + where, kind: 'landing' }, pen, 1.2);
      }
      // sleeves
      let sleeveEff = null;
      if (g('sleeve') != null) {
        const drop = g('shoulder') != null ? Math.max(0, (g('shoulder') - p.shoulder) / 2) : 0;
        sleeveEff = g('sleeve') + drop;
      } else if (g('fullSleeve') != null) {
        sleeveEff = g('fullSleeve') / 2 - p.shoulder / 2;
      } else if (g('neckSleeve') != null) {
        sleeveEff = g('neckSleeve') - p.shoulder / 2 + 2;
      }
      if (sleeveEff != null) {
        const arm = p.armLength;
        const isShort = sleeveEff < arm * 0.6;
        if (isShort) {
          const elbow = arm * 0.55;
          const frac = sleeveEff / elbow;
          const where = frac < 0.45 ? 'cap sleeve' : frac < 0.8 ? 'ends mid upper-arm' : frac < 1.05 ? 'ends just above the elbow' : 'ends around the elbow';
          add({ key: 'sleeve', garment: g('sleeve') || sleeveEff, effective: sleeveEff, body: arm, status: 'ok', verdict: 'short sleeve, ' + where, kind: 'landing' }, null, 0);
        } else {
          const lo = fit === 'oversized' ? -1 : type === 'jacket' || type === 'coat' ? 1 : 0;
          const hi = fit === 'oversized' ? 9 : type === 'jacket' || type === 'coat' ? 6 : 4.5;
          const diff = sleeveEff - arm;
          let status = 'ok', verdict = 'ends at your wrist';
          if (diff < -6) { status = 'tight'; verdict = 'too short — ends well above the wrist'; }
          else if (diff < lo - 1) { status = 'snug'; verdict = 'a bit short — ends just above the wrist'; }
          else if (diff > hi + 3) { status = 'loose'; verdict = 'long — covers part of your hand'; }
          else if (diff > hi) { status = 'ok'; verdict = 'slightly long (bunches at the wrist)'; }
          add({ key: 'sleeve', garment: g('sleeve') || sleeveEff, effective: sleeveEff, body: arm, diff, status, verdict, ideal: [lo, hi], kind: 'ease' },
            rangePenalty(diff, lo, hi, 3, 5), 1);
        }
      }
      if (g('neck') != null && (type === 'shirt')) {
        const diff = g('neck') - p.neck;
        const status = diff < 0 ? 'tight' : diff > 4 ? 'loose' : 'ok';
        add({ key: 'neck', garment: g('neck'), body: p.neck, diff, status, verdict: status === 'tight' ? 'collar too tight to button' : status === 'loose' ? 'loose collar' : 'collar fits', ideal: [1, 3], kind: 'ease' },
          rangePenalty(diff, 1, 3, 1, 3), 0.8);
      }
      if (g('bicep') != null) {
        const diff = g('bicep') - p.bicep;
        const status = diff < 2 ? (diff < 0 ? 'tight' : 'snug') : 'ok';
        add({ key: 'bicep', garment: g('bicep'), body: p.bicep, diff, status, verdict: status === 'ok' ? 'room in the sleeve' : status === 'tight' ? 'tight on the arm' : 'close on the arm', ideal: [3, 20], kind: 'ease' },
          diff < 2 ? rangePenalty(diff, 3, 99, 2, 1) : 0, 0.5);
      }
      if (type === 'dress' || (g('waist') != null && group === 'top' && g('waist') < p.waist + 10)) {
        if (g('waist') != null) {
          const bands = EASE.waistDress;
          const ease = g('waist') - p.waist;
          const lab = easeLabel(bands, ease, stretch);
          add({ key: 'waist', garment: g('waist'), body: p.waist, diff: ease, status: lab.status, verdict: lab.text, ideal: bands[fit], kind: 'ease' },
            rangePenalty(ease, bands[fit][0], bands[fit][1], 2.5, 8), 1.8);
        }
      }
      if (g('hip') != null && (type === 'dress' || (len != null && hemHeightTop(body, len) < body.L.hip + 2))) {
        const bands = EASE.hipDress;
        const ease = g('hip') - p.hip;
        const lab = easeLabel(bands, ease, stretch);
        add({ key: 'hip', garment: g('hip'), body: p.hip, diff: ease, status: lab.status, verdict: lab.text, ideal: bands[fit], kind: 'ease' },
          rangePenalty(ease, bands[fit][0], bands[fit][1], 2.5, 10), 1.5);
      } else if (g('hem') != null && len != null) {
        const hy = hemHeightTop(body, len);
        const bc = bodyCircAt(body, hy);
        const diff = g('hem') - bc;
        if (diff < 2) {
          add({ key: 'hem', garment: g('hem'), body: bc, diff, status: diff < -2 ? 'tight' : 'snug', verdict: diff < -2 ? 'hem tight around hips (rides up)' : 'hem close at the hips', kind: 'ease' },
            rangePenalty(diff, 2, 99, 3, 1), 0.8);
        }
      }
    }

    if (group === 'bottom') {
      const fit = fitBottom;
      if (g('waist') != null) {
        const w = v.waist;
        const bw = p.pantWaist;
        if (w.elastic) {
          let status = 'ok', verdict = `elastic waist ${round1(w.min)}–${round1(w.max)} cm fits`;
          let pen = 0;
          if (bw > w.max) { status = 'tight'; verdict = 'elastic waist too small'; pen = Math.pow((bw - w.max) / 2, 2) + 1; }
          else if (bw > w.max - 3) { status = 'snug'; verdict = 'elastic waist near its stretch limit'; pen = 0.6; }
          else if (bw < w.min - 2) { status = 'loose'; verdict = 'elastic waist loose even relaxed (use the drawstring)'; pen = Math.pow((w.min - bw) / 5, 2); }
          add({ key: 'waist', garment: w.min, garmentMax: w.max, body: bw, diff: w.min - bw, status, verdict, kind: 'elastic' }, pen, 3);
        } else {
          const bands = EASE.waistBottom;
          const ease = g('waist') - bw;
          const lab = easeLabel(bands, ease, stretch);
          let verdict = lab.text;
          if (lab.status === 'ok') verdict = ease < 0.5 ? 'snug waist (fine if the fabric stretches)' : ease <= 3 ? 'waist fits' : 'roomy waist — wear a belt';
          if (lab.status === 'loose' || lab.status === 'big') verdict = 'waist too big — needs a belt or tailoring';
          add({ key: 'waist', garment: g('waist'), body: bw, diff: ease, status: lab.status, verdict, ideal: bands[fit], kind: 'ease' },
            rangePenalty(ease, bands[fit][0], bands[fit][1], stretch ? 2.5 : 1.5, 4), 3);
        }
      }
      if (g('hip') != null) {
        const bands = EASE.hip;
        const ease = g('hip') - p.hip;
        const lab = easeLabel(bands, ease, stretch);
        add({ key: 'hip', garment: g('hip'), body: p.hip, diff: ease, status: lab.status, verdict: lab.text, ideal: bands[fit], kind: 'ease' },
          rangePenalty(ease, bands[fit][0], bands[fit][1], stretch ? 3 : 2, 8), 2.2);
      }
      if (g('thigh') != null) {
        const bands = EASE.thigh;
        const ease = g('thigh') - p.thigh;
        const lab = easeLabel(bands, ease, stretch);
        add({ key: 'thigh', garment: g('thigh'), body: p.thigh, diff: ease, status: lab.status, verdict: lab.text, ideal: bands[fit], kind: 'ease' },
          rangePenalty(ease, bands[fit][0], bands[fit][1], 2.5, 9), 1.4);
      }
      // length
      let hem = null, which = null;
      if (g('inseam') != null) { hem = body.L.crotch - g('inseam'); which = 'inseam'; }
      else if (g('outseam') != null) { hem = body.L.pantWaist - g('outseam'); which = 'outseam'; }
      else if (g('skirtLength') != null) { hem = body.L.pantWaist - g('skirtLength'); which = 'skirtLength'; }
      if (hem != null) {
        const where = describeHeight(body, hem, 'bottom');
        let pen = null, status = 'ok';
        if (type === 'pants') {
          pen = rangePenalty(hem, 0, 8, 8, 4); // too long can be hemmed: gentle
          if (hem > 14) status = 'snug';
          else if (hem < -3) status = 'loose';
        }
        add({ key: which, garment: g(which), hemHeight: hem, status, verdict: 'ends ' + where, kind: 'landing' }, pen, 1.2);
      }
      if (g('rise') != null) {
        const bodyRise = body.L.pantWaist - body.L.crotch; // vertical
        const diff = g('rise') - bodyRise;
        const verdict = diff < -5 ? 'low rise — sits below where you usually wear pants' : diff > 6 ? 'high / dropped rise' : 'rise matches where you wear pants';
        add({ key: 'rise', garment: g('rise'), body: bodyRise, diff, status: diff < -7 ? 'snug' : 'ok', verdict, kind: 'info' }, null, 0);
      }
    }

    if (group === 'shoes') {
      const foot = p.footLength; // cm
      let shoeFoot = null, basis = null;
      if (g('footLength') != null) { shoeFoot = g('footLength'); basis = 'footLength'; }
      else if (g('insole') != null) { shoeFoot = g('insole') - 0.8; basis = 'insole'; }
      else if (g('euSize') != null) { shoeFoot = g('euSize') * (2 / 3) - 1.5; basis = 'euSize'; }
      if (shoeFoot != null) {
        const diffMm = (shoeFoot - foot) * 10;
        let status = 'ok', verdict = 'right length';
        if (diffMm < -4) { status = 'tight'; verdict = 'too short — toes will hit'; }
        else if (diffMm < -1.5) { status = 'snug'; verdict = 'snug fit'; }
        else if (diffMm > 9) { status = 'big'; verdict = 'too long'; }
        else if (diffMm > 5) { status = 'loose'; verdict = 'roomy (thick socks / insoles)'; }
        add({ key: basis, garment: g(basis), body: foot, diff: shoeFoot - foot, status, verdict, kind: 'shoe' },
          rangePenalty(diffMm, -1.5, 4, 2, 4), 4);
      }
    }

    // Seller's suggested height / weight
    if (v.height) {
      const h = p.height;
      const { min, max } = v.height;
      const d = h < min ? min - h : h > max ? h - max : 0;
      add({ key: 'height', garment: min, garmentMax: max, body: h, status: d === 0 ? 'ok' : d < 4 ? 'snug' : 'tight', verdict: d === 0 ? "within seller's height range" : `outside seller's height range by ${round1(d)} cm`, kind: 'range' },
        d === 0 ? 0 : Math.pow(d / 5, 2), weightSum ? 0.4 : 2);
    }
    if (v.weight && p.weight) {
      const w = p.weight;
      const { min, max } = v.weight;
      const d = w < min ? min - w : w > max ? w - max : 0;
      add({ key: 'weight', garment: min, garmentMax: max, body: w, status: d === 0 ? 'ok' : d < 3 ? 'snug' : 'tight', verdict: d === 0 ? "within seller's weight range" : `outside seller's weight range by ${round1(d)} kg`, kind: 'range' },
        d === 0 ? 0 : Math.pow(d / 4, 2), weightSum ? 0.6 : 3);
    }

    const avg = weightSum ? penalty / weightSum : 5;
    // The seller's height/weight suggestion only caps the score when it's all we have.
    const capItems = items.filter((it) => it.kind !== 'range' || items.every((x) => x.kind === 'range'));
    const worst = capItems.reduce((m, it) => (it.status === 'tight' ? Math.max(m, 2) : it.status === 'snug' ? Math.max(m, 1) : m), 0);
    let score = Math.round(100 * Math.exp(-avg / 1.6));
    if (worst === 2) score = Math.min(score, 45);
    return { label: size.label, values: v, items, penalty: avg, score, scored: weightSum > 0 };
  }

  function recommend(chart, profile, opts) {
    const body = buildBody(profile);
    const evals = chart.sizes.map((s) => evaluateSize(s, chart, body, opts));
    const ranked = evals.slice().sort((a, b) => a.penalty - b.penalty);
    const best = ranked[0] || null;
    let summary = '';
    let alternative = null;
    if (best) {
      const idx = evals.indexOf(best);
      const up = evals[idx + 1];
      const down = evals[idx - 1];
      const tight = best.items.filter((i) => i.status === 'tight' || i.status === 'snug').map((i) => (MEASURE_DEFS[i.key] || {}).label || i.key);
      const loose = best.items.filter((i) => i.status === 'loose' || i.status === 'big').map((i) => (MEASURE_DEFS[i.key] || {}).label || i.key);
      if (up && up.penalty < best.penalty * 1.6 + 0.4 && tight.length) alternative = { label: up.label, why: `size up if you want more room in: ${tight.join(', ').toLowerCase()}` };
      else if (down && down.penalty < best.penalty * 1.6 + 0.4 && loose.length) alternative = { label: down.label, why: `size down if you prefer it closer in: ${loose.join(', ').toLowerCase()}` };
      else {
        const near = [up, down].filter((e) => e && e.penalty < best.penalty * 1.3 + 0.3).sort((a, b) => a.penalty - b.penalty)[0];
        if (near) alternative = { label: near.label, why: near === up ? 'also a good fit, slightly roomier' : 'also a good fit, slightly closer' };
      }
      const rating = best.score >= 85 ? 'great fit' : best.score >= 70 ? 'good fit' : best.score >= 50 ? 'acceptable fit' : 'poor fit — no size in this chart suits you well';
      summary = `${best.label}: ${rating}`;
    }
    return { body, evals, best, alternative, summary };
  }

  // Convenience: text in → everything out.
  function analyze(text, profile, opts) {
    opts = opts || {};
    const parsed = parseChart(text, { unit: opts.chartUnit });
    const type = opts.type || detectType(parsed, opts.title);
    const chart = normalizeChart(parsed, type, opts.overrides);
    const result = chart.sizes.length ? recommend(chart, profile, opts) : null;
    return { parsed, chart, type, result };
  }

  return {
    // units
    CM_PER_IN, CM_PER_SHICUN, KG_PER_JIN, KG_PER_LB,
    cmToIn, inToCm, kgToLb, lbToKg, fmtLen, fmtWeight, fmtHeightImperial, fmtSigned, round1,
    // vocab
    MEASURE_DEFS, ALIASES, GARMENT_TYPES, EASE, FIT_ORDER,
    // parsing
    normalizeText, tokenizeLine, parseChart, detectType, normalizeChart, canonicalSize,
    // fit
    buildBody, bodyCircAt, describeHeight, hemHeightTop, evaluateSize, recommend, analyze, mid,
  };
});
