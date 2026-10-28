export const MAX_SOURCE_LENGTH = 50000;
export const STATUS = { preparing: '준비', writing: '원고 작성', submitted: '원고 제출', review: '검수', revision: '수정 요청', published: '발행', completed: '완료', cancelled: '취소' };
export const KINDS = { blog: '블로그 글', reels: '릴스', instagram: '인스타그램', youtube: '유튜브', other: '기타' };
export const sumMoney = list => (list || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
export const outstanding = row => Math.max(0, Number(row.cash_fee || 0) - Number(row.deductions || 0) - sumMoney(row.payments));
export function blankCollaboration() {
  return { title: '', company: '', channel: '', contact: '', products: '', provided_value: 0, cash_fee: 0, deductions: 0,
    requirements: '', keywords: '', required_links: '', memo: '', source_text: '', source_name: '',
    visit_at: null, draft_due: null, publish_due: null, payment_due: null, status: 'preparing',
    deliverables: [], payments: [], expenses: [], reminder_enabled: false, reminder_days: 1, reminder_hour: 9 };
}
export function parseMoney(input) {
  const s = String(input || '').replace(/,/g, '').replace(/\s/g, '');
  if (/협의|미정|추후|~|부터|이상|이하/.test(s)) return null;
  const match = s.match(/(\d+(?:\.\d+)?)\s*(억|천만|백만|십만|만|천)?(?:원|KRW|₩)/i);
  const direct = s.match(/^(?:₩)?(\d+)$/);
  if (!match) return direct ? Number(direct[1]) : null;
  const multipliers = { 억: 1e8, 천만: 1e7, 백만: 1e6, 십만: 1e5, 만: 1e4, 천: 1e3 };
  const n = Number(match[1]) * (multipliers[match[2]] || 1);
  return Number.isSafeInteger(n) && n <= 99999999999 ? n : null;
}
export function parseDate(input, now = new Date()) {
  const s = String(input || '');
  if (/협의|미정|추후|수령\s*후|방문\s*후|발행\s*후|이내|[~～]/.test(s)) return null;
  const m = s.match(/(?:(20\d{2})\s*[년./-]\s*)?(\d{1,2})\s*[월./-]\s*(\d{1,2})(?:일)?/);
  if (!m) return null;
  const year = Number(m[1] || new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(now));
  const month = Number(m[2]), day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, assumedYear: !m[1] };
}
export function extractCollaboration(text, now = new Date()) {
  const source = String(text || '').trim();
  if (!source) throw new Error('협업 메일이나 가이드 내용을 먼저 넣어 주세요.');
  if (source.length > MAX_SOURCE_LENGTH) throw new Error('내용은 50,000자 이내로 넣어 주세요.');
  const draft = blankCollaboration(); draft.source_text = source;
  const evidence = [], warnings = [];
  const lines = source.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const pick = (field, names, max = 1000) => {
    const rx = new RegExp(`^(?:[•·*\\-■□▶▷]\\s*)?\\[?(?:${names})\\]?(?:은|는)?(?:\\s*[:：=]\\s*|\\s+)(.+)$`, 'i');
    let line = lines.find(s => rx.test(s));
    let value = line?.match(rx)?.[1];
    if (!value) {
      const heading = new RegExp(`^(?:[•·*\\-■□▶▷]\\s*)?\\[?(?:${names})\\]?\\s*[:：=]?\\s*$`, 'i');
      const i = lines.findIndex(s => heading.test(s));
      if (i >= 0 && lines[i + 1] && !/^[^:：]{1,24}[:：]/.test(lines[i + 1])) { value = lines[i + 1]; line = `${lines[i]} ${value}`; }
    }
    if (!value) return '';
    value = value.slice(0, max).trim();
    evidence.push({ field, line: line.slice(0, 250) }); return value;
  };
  draft.company = pick('업체명', '업체(?:명)?|브랜드(?:명)?|광고주|회사(?:명)?|상호', 160);
  draft.title = pick('협업명', '협업(?:명)?|캠페인(?:명)?|프로젝트(?:명)?|제목', 160);
  draft.channel = pick('협업 경로', String.raw`협업\s*경로|플랫폼|대행사|진행\s*경로`, 160);
  draft.contact = pick('담당자', '담당자|담당|연락처', 300);
  draft.products = pick('제공 제품·서비스', String.raw`제공(?:받는)?\s*(?:제품|서비스|품목|내역)|제공\s*사항|협찬\s*내용`, 3000);
  draft.requirements = pick('요청사항', String.raw`요청\s*사항|가이드|필수\s*사항|미션|진행\s*조건`, 10000);
  draft.keywords = pick('필수 키워드', String.raw`(?:필수|제목|본문)\s*키워드|키워드|해시태그`, 2000);
  draft.required_links = pick('필수 링크', String.raw`(?:필수|삽입|첨부)\s*(?:링크|URL)|링크`, 4000);
  const feeText = pick('약정 원고료', String.raw`원고료|약정\s*(?:금액|원고료)|현금\s*(?:보수|원고료)|제작비|지급액`, 250);
  const valueText = pick('제품·서비스 제공가', String.raw`(?:제품|서비스|제품·서비스|제공품)\s*(?:가액|금액|제공가)|제공\s*(?:금액|가액)|협찬\s*가액`, 250);
  for (const [field, value, label] of [['cash_fee', feeText, '원고료'], ['provided_value', valueText, '제품·서비스 제공가']]) {
    const amount = parseMoney(value);
    if (amount !== null) draft[field] = amount;
    else if (value) warnings.push(`${label}의 금액을 직접 확인해 주세요: ${value}`);
  }
  for (const [field, names, label] of [
    ['visit_at', String.raw`방문(?:일|\s*일시|\s*예약일)?|예약(?:일|\s*일시)?|촬영일`, '방문·예약일'],
    ['draft_due', String.raw`원고\s*(?:제출일|제출|마감일|마감)|초안\s*(?:제출|마감)`, '원고 제출일'],
    ['publish_due', String.raw`(?:발행|게시|포스팅|업로드)\s*(?:일|일자|마감|마감일|기한)`, '발행 마감일'],
    ['payment_due', String.raw`(?:정산|입금|지급)\s*(?:일|일자|예정일|예정)`, '정산 예정일'],
  ]) {
    const raw = pick(label, names, 250), parsed = parseDate(raw, now);
    if (parsed) {
      if (field === 'visit_at') {
        const time = raw.match(/(?:(오전|오후)\s*)?(\d{1,2})(?::(\d{2})|\s*시)(?:\s*(\d{1,2})분)?/);
        let h = time ? Number(time[2]) : 9, minute = time ? Number(time[3] || time[4] || 0) : 0;
        if (time?.[1] === '오후' && h < 12) h += 12;
        if (time?.[1] === '오전' && h === 12) h = 0;
        if (h > 23 || minute > 59) { h = 9; minute = 0; warnings.push('방문 시간을 확인해 주세요.'); }
        draft[field] = `${parsed.date}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
        if (!time) warnings.push('방문 시간이 없어 오전 9시로 채웠습니다. 실제 시간을 확인해 주세요.');
      } else draft[field] = parsed.date;
      if (parsed.assumedYear) warnings.push(`${label}에 연도가 없어 ${parsed.date.slice(0, 4)}년으로 채웠습니다.`);
    } else if (raw) warnings.push(`${label}를 직접 확인해 주세요: ${raw}`);
  }
  const outputText = pick('결과물', '결과물|제작 콘텐츠|콘텐츠 구성|제공 콘텐츠', 1000) || source;
  for (const [kind, re] of [['blog', /블로그|포스팅/], ['reels', /릴스|reels/i], ['instagram', /인스타(?:그램)?\s*(?:피드|게시물)/], ['youtube', /유튜브|youtube/i]]) {
    if (!re.test(outputText)) continue;
    const countMatch = outputText.match(new RegExp(`(?:${re.source})(?:\\s*글)?\\s*(\\d{1,2})\\s*(?:건|개|편)`, 'i'));
    const count = Math.min(10, countMatch ? Number(countMatch[1]) : 1);
    for (let i = 0; i < count && draft.deliverables.length < 20; i++) draft.deliverables.push({ id: crypto.randomUUID(), kind, name: `${KINDS[kind]}${count > 1 ? ` ${i + 1}` : ''}`, status: 'preparing', due_on: draft.publish_due || '', url: '' });
  }
  if (!draft.title && draft.company) draft.title = `${draft.company} 협업`;
  if (!draft.title) warnings.push('협업명을 입력해 주세요.');
  if (!feeText) warnings.push('현금 원고료를 찾지 못했습니다. 금액이 있다면 직접 입력해 주세요.');
  warnings.push('초안입니다. 날짜·금액·결과물 수량을 원문과 비교한 뒤 저장해 주세요.');
  return { draft, evidence, warnings: [...new Set(warnings)] };
}

let mammothPromise;
function loadMammoth() {
  if (globalThis.mammoth) return Promise.resolve(globalThis.mammoth);
  if (!mammothPromise) mammothPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/collaboration/mammoth-1.13.0.min.js';
    s.onload = () => resolve(globalThis.mammoth); s.onerror = () => { mammothPromise = null; s.remove(); reject(new Error('Word 파일 읽기 도구를 불러오지 못했습니다. 다시 시도해 주세요.')); };
    document.head.append(s);
  });
  return mammothPromise;
}
function htmlText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object').forEach(n => n.remove());
  doc.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
  doc.querySelectorAll('p,div,tr,li,h1,h2,h3').forEach(n => n.append('\n'));
  return doc.body.textContent || '';
}
export async function readGuideFile(file) {
  if (!file || file.size > 5 * 1024 * 1024) throw new Error('5MB 이하의 파일을 선택해 주세요.');
  const ext = file.name.split('.').pop().toLowerCase(); let text;
  if (ext === 'pdf') {
    const pdfjs = await import('./vendor/collaboration/pdf-5.6.205.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/collaboration/pdf-5.6.205.worker.mjs';
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, cMapUrl: '/vendor/collaboration/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/collaboration/standard_fonts/' });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 40) throw new Error('PDF는 40페이지 이하로 나눠서 올려 주세요.');
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i), content = await page.getTextContent();
        let previousY = null;
        pages.push(content.items.map(item => {
          const y = item.transform?.[5], newline = previousY !== null && y !== previousY;
          previousY = y; return `${newline ? '\n' : ' '}${item.str || ''}${item.hasEOL ? '\n' : ''}`;
        }).join('')); page.cleanup();
        if (pages.join('\n').length > MAX_SOURCE_LENGTH) throw new Error('가이드 내용이 너무 깁니다. 필요한 부분만 복사해 넣어 주세요.');
      }
      text = pages.join('\n');
    } finally { await task.destroy(); }
  } else if (ext === 'docx') {
    const mammoth = await loadMammoth();
    text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  } else if (['txt', 'md', 'html', 'htm', 'eml'].includes(ext)) {
    text = await file.text();
    if (['html', 'htm'].includes(ext)) text = htmlText(text);
    if (ext === 'eml' && /Content-Transfer-Encoding:\s*(base64|quoted-printable)/i.test(text)) throw new Error('인코딩된 메일 파일입니다. 메일 본문을 복사해 붙여넣어 주세요.');
  } else throw new Error('PDF, DOCX, TXT, HTML 또는 텍스트 메일(EML)을 올려 주세요. HWP·이미지는 텍스트 PDF로 저장하거나 내용을 붙여넣어 주세요.');
  if (!text?.trim()) throw new Error('파일에서 글자를 읽지 못했습니다. 스캔·이미지 PDF라면 원문의 텍스트를 복사해 넣어 주세요.');
  if (text.length > MAX_SOURCE_LENGTH) throw new Error('내용은 50,000자까지 읽을 수 있습니다. 필요한 부분만 복사해 넣어 주세요.');
  return text.trim();
}
