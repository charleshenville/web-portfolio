import styles from './resume.module.css';
import React, { useState, useEffect, useRef } from 'react';
import AsterDynamic from './AsterDynamic';

function AsciiTool() {

    return (
        <div style={{ width: '100%' }}>

            <header className={styles.header}>

                <div style={{ width: '100%' }}>
                    <AsterDynamic />
                </div>
            
            </header>
        </div>

    );

}

export default AsciiTool;
