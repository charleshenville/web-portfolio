import styles from './projects.module.css';
import React, { useState } from 'react';
import ProjectMedia from './ProjectMedia';

const ProjectCard = ({ items }) => {

    const spotItem = items.find(item => item.id === 0);

    return (

        <div className={styles.mainWidth}>

            <div className={styles.cardSpotPadding}>
                <div className={styles.cardSpotMain}>
                    <ProjectMedia isSpot={true} videoUrl={spotItem.vid} thumbnailUrl={spotItem.thumb} />
                    <div className={styles.spotInfo}>
                        <h3>{spotItem.name}</h3>
                        <div> </div>
                        <p>{spotItem.date}</p>
                    </div>
                </div>
            </div>

            <div className={styles.cardWrapper}>
                {items.map((item) => (
                    (item.id) == 0 ? (null) :
                        (
                            <div className={styles.cardPadding}>
                                <div className={styles.cardMain}>
                                    <ProjectMedia isSpot={false} videoUrl={item.vid} thumbnailUrl={item.thumb} />
                                    <h3>{item.name}</h3>
                                    <p>{item.date}</p>
                                </div>
                            </div>
                        )

                ))}
            </div>

        </div>

    );
};

export default ProjectCard;