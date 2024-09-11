import React from 'react';
import items from './languages.json'
import styles from './resume.module.css'
import { useEffect, useRef } from 'react';

function Languages() {

    function getGradientColor(fraction) {
        if (fraction < 0 || fraction > 1) {
            throw new Error("Fraction must be between 0 and 1.");
        }

        const startColor = [143, 0, 255];  // #8F00FF
        const endColor = [255, 168, 0];   // #FFA800

        const interpolatedColor = startColor.map((start, index) => {
            const end = endColor[index];
            const range = end - start;
            return Math.round(start + range * fraction);
        });

        const hexColor = interpolatedColor.reduce((acc, val) => {
            const hex = val.toString(16).padStart(2, '0');
            return acc + hex;
        }, '#');

        return hexColor;
    }

    const observe = styles.obsr2

    const observer = useRef(null);
    useEffect(() => {
        observer.current = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    // Element is intersecting with the viewport
                    entry.target.classList.add(observe);
                    entry.target.style.opacity = '1';
                    entry.target.style.transition = 'opacity 0.7s ease-out';

                }
                else {
                    entry.target.classList.remove(observe);
                    entry.target.style.opacity = '0';
                }
            });
        });

        const elements = document.querySelectorAll(`.${observe}`);
        elements.forEach((element) => {
            observer.current.observe(element);
        });

        // Cleanup the observer when the component unmounts
        return () => {
            observer.current.disconnect();
        };
    }, []);

    return (

        <div className={styles.langCTR}>
            {items.map((item) => (

                <div className={styles.langPadding}>
                    <div className={styles.buttonContainer}>
                        <div style={{ backgroundColor: getGradientColor(item.proficiency) }} className={styles.highlighter}></div>
                        <a className={observe} style={{textDecoration: 'none'}} title={item.id} target='blank' href={item.repo}>
                            <div className={styles.langRow}>
                                <p style={{ paddingRight: "10px" }}>{item.id}</p>
                                <div className={styles.subs}>
                                    {item.subs.map((sub) => (
                                        <p style={{ margin: "5px", paddingRight: "5px" }}>{sub}</p>
                                    ))}
                                </div>
                            </div>
                        </a>
                    </div>
                </div>

            ))}
        </div>

    );

}

export default Languages;