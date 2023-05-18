import React from 'react';
import items from './languages.json'
import styles from './resume.module.css'

function Languages() {

    return (

        <div>
            {items.map((item) => (

                <div className={styles.langPadding}>
                    <div className={styles.langRow}>
                        <p style={{paddingRight:"10px"}}>.{item.ext}</p>
                        <div className={styles.subs}>
                            {item.subs.map((sub) => (
                                <p style={{margin:"5px", paddingRight:"5px"}}>&gt;{sub}</p>
                            ))}
                        </div>
                    </div>
                </div>

            ))}
        </div>

    );

}

export default Languages;