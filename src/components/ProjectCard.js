import styles from './projects.module.css';
import React, { useRef, useEffect } from 'react';
import Spotlight from './Spotlight';
import ProjectMedia from './ProjectMedia';
import Other from './Other';
import Footer from './Footer';

const ProjectCard = ({ items }) => {

    const spotItem = items.find(item => item.id === 0);

    const observe = styles.observe
    const observer = useRef(null);
    useEffect(() => {
        observer.current = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add(observe);
                    // entry.target.style.filter = 'blur(0)';
                    // entry.target.style.transition = 'filter 1s ease-out';
                    entry.target.style.opacity = '1';
                    entry.target.style.transition = 'opacity 1s ease-out';
                }
                else {
                    entry.target.classList.remove(observe);
                    // entry.target.style.filter = 'blur(5px)';
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

        <div className={styles.mainWidth}>
            <div style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <Spotlight />
            </div>

            <a className={observe} style={{ textDecoration: 'none' }} href={spotItem.repo} target="blank">
                <div className={styles.cardSpotPadding}>
                    <div className={styles.cardSpotMain}>
                        <ProjectMedia isSpot={false} videoUrl={spotItem.vid} thumbnailUrl={spotItem.thumb} />
                        <div className={styles.cardSpotText}>
                            <div style={{ minWidth: '50%', textAlign: 'left' }}>
                                <p>{spotItem.name}</p>
                            </div>

                            <div style={{ justifyContent: 'right', width: '100%', padding: '0', textAlign: 'right' }}>
                                <p>{spotItem.date}</p>
                            </div>

                        </div>
                    </div>
                </div>
            </a>


            <div style={{ width: '100%', display: 'flex', justifyContent: 'center', alignContent: 'center' }}>
                <Other />
            </div>

            <div className={styles.cardWrapper}>
                {items.map((item) => (
                    (item.id) == 0 ? (null) :
                        (
                            <a className={observe} style={{ textDecoration: 'none' }} href={item.repo} target="blank">
                                <div className={styles.cardPadding}>
                                    <div className={styles.cardMain}>
                                        <ProjectMedia isSpot={false} videoUrl={item.vid} thumbnailUrl={item.thumb} />
                                        <div className={styles.cardText}>
                                            <div style={{ minWidth: '80%', textAlign: 'left' }}>
                                                <p>{item.name}</p>
                                            </div>

                                            <div style={{ justifyContent: 'right', width: '100%', padding: '0', textAlign: 'right' }}>
                                                <p>{item.date}</p>
                                            </div>

                                        </div>

                                    </div>
                                </div>
                            </a>

                        )

                ))}
            </div>

            <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }} className={observe}>
                <Footer />
            </div>

        </div>

    );
};

export default ProjectCard;