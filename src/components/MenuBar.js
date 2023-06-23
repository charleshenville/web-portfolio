import React from "react";
import styles from "./menu.module.css";

function MenuBar() {

    const navigateAndReload = (path) => {
        window.location.href = path;
        window.scrollTo(0,0);
        window.location.reload();
        
    };

    return (
        <div className={styles.main}>
            <a href="/" className={styles.txt} onClick={() => navigateAndReload('/')}>Home</a>
            <a href="#/projects" className={styles.txt} onClick={() => navigateAndReload('/#/projects')}>Projects</a>
            <a href="/#/resume" className={styles.txt} onClick={() => navigateAndReload('/#/resume')}>Resume</a>
            <a href="/#/contact" className={styles.txt} onClick={() => navigateAndReload('/#/contact')}>Contact</a>
            <a href="https://github.com/charleshenville/web-portfolio" target="_blank" className={styles.txt}>Source</a>
        </div>
    );

}

export default MenuBar;