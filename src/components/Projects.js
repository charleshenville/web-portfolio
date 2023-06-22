import styles from './projects.module.css';
import React from 'react';
import ProjectCard from './ProjectCard';

import items from './projectitems.json';
import * as THREE from 'three';

function Projects() {

    return (
        <div>
            <header className={styles.header}>
                <div className={styles.flatAsterisk}>
                    <svg width="2001" height="1000" viewBox="0 0 2001 2001" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M511.302 138.204L950.83 0.977555L1145.52 622.875L1732.54 217.036L2000.98 590.759L1446.41 996.598L2000.98 1414.12L1732.54 1787.84L1145.52 1379.08L950.83 2000.98L511.302 1863.75L711.892 1253.53H0.977539L0.977539 748.423H711.892L511.302 138.204Z" fill="#2C2B2B" />
                    </svg>
                </div>
                <div style={{width:"100%"}}>
                    <ProjectCard items={items} />
                </div>
                
            </header>

        </div>

    );

}

export default Projects;
