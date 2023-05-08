import React from "react";
import styles from "./menu.module.css";

function MenuBar() {

    return (
        <div className={styles.main}>

            <a href="/" className={styles.txt}>Home</a>
            <a href="/projects" className={styles.txt}>Projects</a>
            <a className={styles.txt}>Resume</a>
            <a className={styles.txt}>Page Source</a>
            <a className={styles.txt}>Contact Me</a>
        </div>
    );

}

export default MenuBar;