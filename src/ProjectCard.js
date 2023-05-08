import styles from './projects.module.css';
import React, { useState } from 'react';
import ProjectMedia from './ProjectMedia';

const ProjectCard = ({ items }) => {

    return (
        <div>
            {items.map((item) => (
                <div className={styles.cardMain}>
                    <ProjectMedia videoUrl={item.vid} thumbnailUrl={item.thumb}/>
                    <p>{item.name}</p>
                    <p>{item.date}</p>
                </div>
            ))}
        </div>
    );
};

export default ProjectCard;