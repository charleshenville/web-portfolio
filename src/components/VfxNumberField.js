import React, { useState, useEffect } from 'react';
import styles from './vfx.module.css';

// Text field that lets you type freely (decimals, minus sign) while still
// staying in sync with its slider. Commits only valid numbers, and lets you
// override the slider's range by typing a value outside of it.
function VfxNumberField({ value, min, max, step, disabled, onCommit }) {
    const [text, setText] = useState(String(value));
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        if (!focused) setText(String(value));
    }, [value, focused]);

    return (
        <input
            className={styles.vfx_num}
            type="number"
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={text}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); setText(String(value)); }}
            onChange={(e) => {
                setText(e.target.value);
                const n = parseFloat(e.target.value);
                if (!Number.isNaN(n)) onCommit(n);
            }}
        />
    );
}

export default VfxNumberField;
