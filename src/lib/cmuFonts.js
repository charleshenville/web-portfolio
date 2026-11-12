// The Computer Modern Unicode fonts (TeX's own, under the SIL Open Font
// Licence: public/fonts/cmu/OFL.txt), for text that should sit beside LaTeX.
// Registered with the document up front, but each file is only fetched
// the first time something draws in that face.

const PUB = process.env.PUBLIC_URL || '';

// [family, file, weight, style]
const FACES = [
    ['CMU Serif', 'serif-500-roman', 500, 'normal'],
    ['CMU Serif', 'serif-500-italic', 500, 'italic'],
    ['CMU Serif', 'serif-700-roman', 700, 'normal'],
    ['CMU Serif', 'serif-700-italic', 700, 'italic'],
    ['CMU Sans Serif', 'sans-serif-500-roman', 500, 'normal'],
    ['CMU Sans Serif', 'sans-serif-500-italic', 500, 'italic'],
    ['CMU Sans Serif', 'sans-serif-700-roman', 700, 'normal'],
    ['CMU Sans Serif', 'sans-serif-700-italic', 700, 'italic'],
    ['CMU Typewriter Text', 'typewriter-text-500-roman', 500, 'normal'],
    ['CMU Typewriter Text', 'typewriter-text-500-italic', 500, 'italic'],
    ['CMU Typewriter Text', 'typewriter-text-700-roman', 700, 'normal'],
    ['CMU Concrete', 'concrete-500-roman', 500, 'normal'],
    ['CMU Concrete', 'concrete-500-italic', 500, 'italic'],
    ['CMU Bright', 'bright-500-roman', 500, 'normal'],
    ['CMU Bright', 'bright-500-italic', 500, 'italic'],
    ['CMU Bright', 'bright-700-roman', 700, 'normal'],
];

/** The font menu's entries: [id, label, CSS font-family]. */
export const CMU_FONTS = [
    ['cmuSerif', 'CMU Serif (LaTeX)', "'CMU Serif', 'Latin Modern Roman', serif"],
    ['cmuSans', 'CMU Sans Serif', "'CMU Sans Serif', sans-serif"],
    ['cmuMono', 'CMU Typewriter', "'CMU Typewriter Text', monospace"],
    ['cmuConcrete', 'CMU Concrete', "'CMU Concrete', serif"],
    ['cmuBright', 'CMU Bright', "'CMU Bright', sans-serif"],
];

let registered = false;

export function registerCmuFonts() {
    if (registered || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return;
    registered = true;
    FACES.forEach(([family, file, weight, style]) => {
        try {
            document.fonts.add(new FontFace(family, `url(${PUB}/fonts/cmu/cmu-${file}.woff2) format('woff2')`, { weight: String(weight), style }));
        } catch (e) {
            // A browser without FontFace keeps its fallback serif.
        }
    });
}
