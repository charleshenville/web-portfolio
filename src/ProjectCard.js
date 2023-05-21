import styles from './projects.module.css';
import React, { useState } from 'react';
import Spotlight from './Spotlight';
import ProjectMedia from './ProjectMedia';
import Other from './Other';
import { SpotLight } from 'three';

const ProjectCard = ({ items }) => {

    const spotItem = items.find(item => item.id === 0);

    return (

        <div className={styles.mainWidth}>
            <Spotlight/>
            <div className={styles.cardSpotPadding}>
                <div className={styles.cardSpotMain}>
                    <ProjectMedia isSpot={true} videoUrl={spotItem.vid} thumbnailUrl={spotItem.thumb} />
                    <div className={styles.spotInfo}>
                        <p>{spotItem.name}</p>
                        <p>{spotItem.date}</p>
                    </div>
                </div>
            </div>

            <Other />

            <div className={styles.cardWrapper}>
                {items.map((item) => (
                    (item.id) == 0 ? (null) :
                        (
                            <div className={styles.cardPadding}>
                                <div className={styles.cardMain}>
                                    <ProjectMedia isSpot={false} videoUrl={item.vid} thumbnailUrl={item.thumb} />
                                    <div className={styles.cardText}>
                                        <div style={{ minWidth: '80%', textAlign:'left' }}>
                                            <p>{item.name}</p>
                                        </div>

                                        <div style={{ justifyContent: 'right', width: '100%', padding: '0', textAlign: 'right' }}>
                                            <p>{item.date}</p>
                                        </div>

                                    </div>

                                </div>
                            </div>
                        )

                ))}
            </div>

        </div>

    );
};

export default ProjectCard;