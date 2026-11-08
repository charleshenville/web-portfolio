// The compositor's own film and music glyphs, drawn to sit with the site's
// square corners: a film frame with no rounding, and a note with solid heads.
// Same props and stroke as the lucide icons beside them.

import React from 'react';

function Glyph({
    size = 24, strokeWidth = 2, className, style, children, ...rest
}) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="square"
            strokeLinejoin="miter"
            className={className}
            style={style}
            aria-hidden="true"
            {...rest}
        >
            {children}
        </svg>
    );
}

export function Film(props) {
    return (
        <Glyph {...props}>
            <rect x="3" y="3" width="18" height="18" />
            <path d="M7.5 3v18M16.5 3v18M3 12h18M3 7.5h4.5M3 16.5h4.5M16.5 7.5H21M16.5 16.5H21" />
        </Glyph>
    );
}

export function Music(props) {
    return (
        <Glyph {...props}>
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" fill="currentColor" />
            <circle cx="18" cy="16" r="3" fill="currentColor" />
        </Glyph>
    );
}
