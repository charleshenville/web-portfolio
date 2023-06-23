import React from "react";
import styles from "./menu.module.css";

function MenuBar() {

    return (
        <div className={styles.main}>
            <a href="/" className={styles.txt}>Home</a>
            <a href="/#/projects" className={styles.txt}>Projects</a>
            <a href="/#/resume" className={styles.txt}>Resume</a>
            <a href="/#/contact" className={styles.txt}>Contact</a>
            <a href="https://github.com/charleshenville/web-portfolio" target="_blank" className={styles.txt}>Source</a>
        </div>
    );

}

export default MenuBar;