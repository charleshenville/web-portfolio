// Fonts the ascii glyphs can be drawn in. System and site fonts by id, or
// any installed / loaded font by name ('custom').

export const GLYPH_FONTS = [
    ['mono', 'SF Mono (site)', "'SF Mono', ui-monospace, Menlo, Monaco, monospace"],
    ['grotesk', 'Inter Tight (site)', "'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif"],
    ['menlo', 'Menlo', 'Menlo, Monaco, monospace'],
    ['courier', 'Courier', "'Courier New', Courier, monospace"],
    ['helvetica', 'Helvetica', "'Helvetica Neue', Helvetica, Arial, sans-serif"],
    ['georgia', 'Georgia', 'Georgia, serif'],
    ['times', 'Times', "'Times New Roman', Times, serif"],
    ['impact', 'Impact', 'Impact, Haettenschweiler, sans-serif'],
    ['custom', 'Other (by name)…', null],
];

export const GLYPH_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

const STACK = Object.fromEntries(GLYPH_FONTS.map(([id, , stack]) => [id, stack]));

/** The CSS font-family for a settings object's glyph font. */
export function glyphFontStack(s) {
    if (s.glyphFont === 'custom' && s.glyphFontCustom) {
        return `"${String(s.glyphFontCustom).replace(/"/g, '')}", ${STACK.mono}`;
    }
    return STACK[s.glyphFont] || STACK.mono;
}

/** CSS font shorthand at `px` pixels. */
export const glyphFont = (s, px) => `${s.glyphItalic ? 'italic ' : ''}${s.glyphWeight || 400} ${px}px ${glyphFontStack(s)}`;
