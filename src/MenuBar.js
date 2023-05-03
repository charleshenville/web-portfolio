import React from "react";
import styles from "./menu.module.css";

function MenuBar() {

    return (
        <div className={styles.main}>
            <div></div>
            <a className={styles.txt}>Home</a>
            <a className={styles.txt}>Projects</a>
            <a className={styles.txt}>Resume</a>
            <div></div>
        </div>
    );

}

export default MenuBar;