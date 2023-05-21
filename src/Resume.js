import styles from './resume.module.css';
import React from 'react';
import TechSkills from './TechSkills';
import Languages from './Languages';
import Aster from './Aster';
import exps from './expconfig.json';
import PracticalGraphic from './PracticalGraphic';

function Resume() {

    return (
        <div style={{width:'100%'}}>

            <header className={styles.header}>

                <TechSkills />
                <Aster />
                <div className={styles.barContainer}>
                    <div className={styles.expBar}>

                        <div style={{ display: 'flex', justifyContent: 'right', textAlign: 'right', padding: '20px' }}><p>Less Capable</p></div>
                        <div className={styles.bar}></div>
                        <div style={{ display: 'flex', justifyContent: 'left', textAlign: 'left', padding: '20px' }}><p>More Capable</p></div>

                    </div>
                </div>
                <Languages />
                <div className={styles.barContainer2}>
                    <div className={styles.expBar2}>
                        <div style={{ display: 'flex', justifyContent: 'right', textAlign: 'right', padding: '20px' }}></div>
                        <div className={styles.bar}></div>
                        <div style={{ display: 'flex', justifyContent: 'left', textAlign: 'left', padding: '20px' }}></div>
                    </div>
                </div>
                <div style={{width:'100%'}}>
                    <h1 style={{ stroke: "5px" }}>Practical Experience</h1>
                    {exps.map((item) => (

                        <div className={styles.praContainer}>
                            <div className={styles.praMain}>
                                <div style={{ display: 'flex', flexDirection: 'row' , justifyContent: 'center', alignContent: 'center'}}>
                                    <div className={styles.praTitle}>
                                        <p >{item.company}</p>
                                        <p >{item.role} ({item.year})</p>
                                    </div>
                                    <div style={{display:'flex', justifyContent:'right', alignContent:'center', width:'33%'}}> 
                                        <PracticalGraphic id={item.id} />
                                    </div>
                                   
                                </div>

                                <div style={{ backgroundColor: 'white', height: '2px', width: '100%' }} />
                                <div className={styles.infoBit}>
                                    {item.info.map((i) => (

                                        <div style={{ display: 'flex', flexDirection: 'row' }}>
                                            <p >●</p>
                                            <p style={{ paddingLeft: '6px' }}>{i}</p>
                                        </div>

                                    ))}
                                </div>
                            </div>
                        </div>

                    ))}
                </div>
                <div className={styles.barContainer2}>
                    <div className={styles.expBar2}>
                        <div style={{ display: 'flex', justifyContent: 'right', textAlign: 'right', padding: '20px' }}></div>
                        <div className={styles.bar}></div>
                        <div style={{ display: 'flex', justifyContent: 'left', textAlign: 'left', padding: '20px' }}></div>
                    </div>
                </div>

            </header>

        </div>

    );

}

export default Resume;
