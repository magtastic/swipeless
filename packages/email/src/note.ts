/**
 * The HTML body every email shares: a note passed in class, on the ruled
 * notebook page from PRODUCT.md, Visual identity. Red margin line, ink-blue
 * handwriting, yellow highlighter.
 *
 * Email clients are not browsers. Gmail drops web fonts, gradients and most
 * CSS, so the rules are table borders, every style is inline, and the
 * handwriting falls back to whatever cursive the reader has. Apple Mail and
 * iOS load Nanum Pen Script.
 */

const PAPER = '#FBFCF8'
const SHEET = '#FFFFFE'
const RULE = '#D6E2F3'
const MARGIN = '#EE939C'
const INK = '#2232A8'
const TEXT = '#262C5C'
const SOFT = '#586089'
const HI = '#F6EE5C'
const HI_INK = '#1E2342'

const HAND =
  "'Nanum Pen Script', 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive"
const BODY = "Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif"

/** Names and venues come from people; nothing reaches the HTML unescaped. */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

/** One ruled line of the page. */
export type Line =
  /** Handwritten, in ink. Already-escaped HTML. */
  | { readonly hand: string; readonly size?: number }
  /** Small print in the body face. Already-escaped HTML. */
  | { readonly print: string }
  /** An empty ruled line. */
  | { readonly blank: true }

/** Highlighter over a few words. Takes escaped HTML. */
export const highlight = (html: string): string =>
  `<span style="background:${HI};color:${HI_INK};padding:0 4px;">${html}</span>`

/** A drawn checkbox and its label, for "☐ yes ☐ no", linked when given a URL. */
export const checkbox = (label: string, href?: string): string => {
  const box = `<span style="display:inline-block;width:22px;height:22px;border:2px solid ${INK};border-radius:3px;vertical-align:-3px;margin-right:8px;"></span>${escapeHtml(label)}`
  return href
    ? `<a href="${escapeHtml(href)}" style="color:${INK};text-decoration:none;">${box}</a>`
    : box
}

const row = (content: string, style: string) =>
  `<tr><td width="44" style="width:44px;border-right:2px solid ${MARGIN};border-bottom:1px solid ${RULE};">&nbsp;</td><td style="padding:0 24px 0 16px;border-bottom:1px solid ${RULE};${style}">${content}</td></tr>`

const renderLine = (line: Line): string => {
  if ('blank' in line) return row('&nbsp;', 'height:36px;')
  if ('print' in line) {
    return row(
      line.print,
      `font-family:${BODY};font-size:13px;line-height:18px;color:${SOFT};padding-top:9px;padding-bottom:9px;`
    )
  }
  const size = line.size ?? 26
  return row(
    line.hand,
    `font-family:${HAND};font-size:${size}px;line-height:36px;color:${INK};padding-top:${size > 30 ? 6 : 0}px;padding-bottom:${size > 30 ? 6 : 0}px;`
  )
}

/** The whole page: preheader, the note, and a dry footer under it. */
export const note = (preheader: string, lines: ReadonlyArray<Line>): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Nanum+Pen+Script&display=swap" rel="stylesheet">
<title>swipeless</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${SHEET};border:1px solid ${RULE};border-radius:4px;box-shadow:0 2px 0 ${RULE};">
${row('&nbsp;', 'height:28px;')}
${lines.map(renderLine).join('\n')}
${row('&nbsp;', 'height:28px;')}
</table>
<p style="margin:16px 0 0;font-family:${BODY};font-size:12px;line-height:18px;color:${SOFT};">
<span style="color:${TEXT};font-weight:600;">swipeless</span> · no swiping. no small talk. just a date.
</p>
</td></tr>
</table>
</body>
</html>`
