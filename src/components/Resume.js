import styles from './resume.module.css';
import React, { useState, useEffect, useRef } from 'react';
import TechSkills from './TechSkills';
import Languages from './Languages';
import Aster from './Aster';
import exps from './expconfig.json';
import PracticalGraphic from './PracticalGraphic';

function Resume() {

    function min(x, y) {
        if (x > y) { return (y); }
        return (x);
    }
    const [toTop, setToTop] = useState(0);
    const [ampOpacity, setAmpOpacity] = useState(0);
    let yam;
    function handleScroll() {

        yam = window.pageYOffset;
        setToTop(-1 * 0.12 * yam + 500);
        if (yam >= 0.5 * window.innerHeight) {
            setAmpOpacity(min((yam - 0.4 * window.innerHeight) / window.innerHeight, 1));
        }
        else {
            setAmpOpacity(0);
        }
    };

    document.body.onscroll = handleScroll;

    const observe = styles.observe

    const observer = useRef(null);
    useEffect(() => {
        observer.current = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    // Element is intersecting with the viewport
                    entry.target.classList.add(observe);
                    entry.target.style.filter = 'blur(0)';
                    entry.target.style.transition = 'filter 1s ease-out';

                }
                else {
                    entry.target.classList.remove(observe);
                    entry.target.style.filter = 'blur(5px)';
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

    const ampersand = {
        zIndex: '-1',
        position: 'fixed',
        top: toTop,
        opacity: ampOpacity,
        display: 'flex',
        height: '130vh'
    };

    return (
        <div style={{ width: '100%' }}>

            <header className={styles.header}>

                <TechSkills />
                <Aster />
                <div className={observe} style={{width: '100%'}}>
                    <div className={styles.barContainer}>
                        <div className={styles.expBar}>

                            <div style={{ display: 'flex', justifyContent: 'right', textAlign: 'right', padding: '20px' }}><p>Less Capable</p></div>
                            <div className={styles.bar}></div>
                            <div style={{ display: 'flex', justifyContent: 'left', textAlign: 'left', padding: '20px' }}><p>More Capable</p></div>

                        </div>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'right' }}>
                    <div id='amp' style={ampersand}>
                        <svg viewBox="0 0 1865 2427" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M415.706 1965.66C221.916 1876.44 96.7949 1749.66 40.3433 1585.32C-16.1083 1420.99 -12.2833 1269.2 51.8182 1129.97C104.772 1014.95 178.71 929.507 273.632 873.64C368.555 817.772 499.415 779.498 666.213 758.818L717.789 752.692C691.087 664.935 677.527 581.657 677.108 502.857C676.689 424.057 692.605 349.632 724.854 279.584C788.956 140.352 885.641 53.3285 1014.91 18.5136C1144.57 -17.1661 1283.81 -0.751928 1432.61 67.7561C1568.44 130.29 1661.96 222.083 1713.17 343.135C1765.65 463.722 1763.23 586.28 1705.89 710.81C1654.14 823.234 1585.31 902.122 1499.42 947.476C1414.4 993.228 1306.68 1022.24 1176.25 1034.51L1293.39 1494.06C1345.24 1463.43 1391.53 1425.52 1432.25 1380.33C1473.84 1335.55 1508.6 1283.95 1536.54 1225.54L1864.86 1376.7C1806.32 1490.19 1724.69 1594.62 1619.96 1690C1561.62 1743.84 1482.79 1796.64 1383.47 1848.39L1538.95 2426.2L1089.95 2219.48L1032.24 1996.39C940.744 2026.59 860.744 2043.21 792.237 2046.26C670.121 2051.87 544.611 2025.01 415.706 1965.66ZM799.857 1076.61C679.019 1095.39 592.711 1121.16 540.931 1153.92C490.017 1187.07 451.62 1231.76 425.74 1287.97C396.676 1351.1 395.521 1420.79 422.277 1497.04C449.898 1573.69 503.938 1630.54 584.395 1667.58C644.955 1695.46 708.424 1707.91 774.803 1704.94C842.445 1701.49 901.099 1690.24 950.765 1671.18L799.857 1076.61ZM1070.82 423.145C1054.9 457.737 1050.29 499.634 1056.99 548.838C1061.02 581.086 1074.26 641.157 1096.7 729.05C1165.33 716.627 1216.67 703.053 1250.71 688.33C1315.46 661.546 1360.38 620.913 1385.47 566.431C1403.78 526.651 1407.13 485.22 1395.51 442.138C1383.89 399.056 1351.69 365.367 1298.92 341.071C1266.04 325.935 1231.15 320.876 1194.24 325.893C1138.64 332.786 1097.5 365.204 1070.82 423.145Z" fill="#202020" />
                        </svg>
                    </div>
                </div>

                <Languages />

                <div style={{ width: '100%' }}>
                    <div className={observe} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                        <div style={{ width: '90%', padding: '8%' }}>
                            <svg viewBox="0 0 1835 287" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M0.148607 2.32942H84.1116C131.963 2.32942 161.387 17.9927 161.387 43.4556C161.387 68.5973 130.477 84.2606 80.8422 84.2606H54.6874V118.238H0.148607V2.32942ZM54.6874 24.74V61.85H70.2911C95.2571 61.85 106.254 56.1469 106.254 43.295C106.254 30.443 95.2571 24.74 70.2911 24.74H54.6874Z" fill="white" />
                                <path d="M255.01 24.5793V56.8699H275.22C294.836 56.8699 307.171 50.5242 307.171 40.4836C307.171 30.684 294.985 24.5793 275.072 24.5793H255.01ZM271.208 77.6739H255.01V118.238H200.471V2.32942H282.799C332.88 2.32942 362.898 16.6272 362.898 40.564C362.898 55.424 348.781 68.035 326.341 73.3364L368.546 118.238H307.319L271.208 77.6739Z" fill="white" />
                                <path d="M473.313 71.5693H510.614L493.673 28.4349H490.849L473.313 71.5693ZM529.041 118.238L519.084 92.775H464.694L454.44 118.238H400.347L460.979 2.32942H527.704L588.484 118.238H529.041Z" fill="white" />
                                <path d="M699.048 95.9076C716.286 95.9076 726.986 88.0358 726.986 75.3445H782.416C782.416 103.94 751.952 120.567 699.345 120.567C644.212 120.567 611.518 102.896 611.518 73.0954V47.4719C611.518 17.6714 644.212 0 699.345 0C751.952 0 782.119 16.6272 782.119 45.7047H726.689C726.689 32.7725 715.692 24.6597 698.156 24.6597C678.688 24.6597 668.435 32.5315 668.435 47.4719V73.0954C668.435 88.1161 678.837 95.9076 699.048 95.9076Z" fill="white" />
                                <path d="M933.55 118.238H879.159V72.1315V26.0252H820.311V2.32942H992.398V26.0252H933.55V118.238Z" fill="white" />
                                <path d="M1192.64 118.238H1047.9V94.5421H1093.07V26.0252H1047.9V2.32942H1192.64V26.0252H1147.46V94.5421H1192.64V118.238Z" fill="white" />
                                <path d="M1334.79 95.9076C1352.03 95.9076 1362.73 88.0358 1362.73 75.3445H1418.16C1418.16 103.94 1387.69 120.567 1335.09 120.567C1279.95 120.567 1247.26 102.896 1247.26 73.0954V47.4719C1247.26 17.6714 1279.95 0 1335.09 0C1387.69 0 1417.86 16.6272 1417.86 45.7047H1362.43C1362.43 32.7725 1351.43 24.6597 1333.9 24.6597C1314.43 24.6597 1304.18 32.5315 1304.18 47.4719V73.0954C1304.18 88.1161 1314.58 95.9076 1334.79 95.9076Z" fill="white" />
                                <path d="M1520.99 71.5693H1558.29L1541.35 28.4349H1538.53L1520.99 71.5693ZM1576.72 118.238L1566.76 92.775H1512.37L1502.12 118.238H1448.03L1508.66 2.32942H1575.38L1636.16 118.238H1576.72Z" fill="white" />
                                <path d="M1832.47 93.8995V118.238H1690.7V60.2837V2.32942H1744.35V93.8995H1832.47Z" fill="white" />
                                <path d="M141.771 260.975V284.671H0V168.762H141.771V192.458H54.5388V215.591H136.273V237.279H54.5388V260.975H141.771Z" fill="white" />
                                <path d="M162.279 284.671L222.465 226.194L162.279 168.762H221.425L256.347 207.157H259.022L293.945 168.762H350.415L287.703 226.516L350.415 284.671H293.35L255.901 247.962H253.375L216.223 284.671H162.279Z" fill="white" />
                                <path d="M366.911 168.762H450.874C498.725 168.762 528.149 184.425 528.149 209.888C528.149 235.03 497.239 250.693 447.604 250.693H421.45V284.671H366.911V168.762ZM421.45 191.173V228.283H437.053C462.019 228.283 473.016 222.58 473.016 209.728C473.016 196.876 462.019 191.173 437.053 191.173H421.45Z" fill="white" />
                                <path d="M706.181 260.975V284.671H564.41V168.762H706.181V192.458H618.948V215.591H700.682V237.279H618.948V260.975H706.181Z" fill="white" />
                                <path d="M798.02 191.012V223.303H818.23C837.847 223.303 850.181 216.957 850.181 206.916C850.181 197.117 837.995 191.012 818.082 191.012H798.02ZM814.218 244.107H798.02V284.671H743.481V168.762H825.809C875.89 168.762 905.909 183.06 905.909 206.997C905.909 221.857 891.791 234.468 869.351 239.769L911.556 284.671H850.33L814.218 244.107Z" fill="white" />
                                <path d="M1081.27 284.671H936.522V260.975H981.698V192.458H936.522V168.762H1081.27V192.458H1036.09V260.975H1081.27V284.671Z" fill="white" />
                                <path d="M1270.59 260.975V284.671H1128.82V168.762H1270.59V192.458H1183.36V215.591H1265.09V237.279H1183.36V260.975H1270.59Z" fill="white" />
                                <path d="M1353.36 284.671H1307.15V168.762H1354.11L1414.14 238.002H1416.97V168.762H1463.19V284.671H1416.23L1356.19 214.788H1353.36V284.671Z" fill="white" />
                                <path d="M1577.91 262.34C1595.15 262.34 1605.85 254.469 1605.85 241.777H1661.28C1661.28 270.373 1630.81 287 1578.21 287C1523.07 287 1490.38 269.329 1490.38 239.528V213.905C1490.38 184.104 1523.07 166.433 1578.21 166.433C1630.81 166.433 1660.98 183.06 1660.98 212.137H1605.55C1605.55 199.205 1594.55 191.092 1577.02 191.092C1557.55 191.092 1547.3 198.964 1547.3 213.905V239.528C1547.3 254.549 1557.7 262.34 1577.91 262.34Z" fill="white" />
                                <path d="M1835 260.975V284.671H1693.23V168.762H1835V192.458H1747.77V215.591H1829.5V237.279H1747.77V260.975H1835Z" fill="white" />
                            </svg>
                        </div>
                    </div>


                    {exps.map((item) => (

                        <div className={observe}>
                            <div className={styles.praContainer}>
                                <div className={styles.praMain}>
                                    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', alignContent: 'center' }}>
                                        <div className={styles.praTitle}>
                                            <p style={{ fontWeight: 'bold' }}>{item.company}</p>
                                            <p style={{ fontSize: 'x-large' }}>{item.role} ({item.year})</p>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'right', alignContent: 'center', width: '33%' }}>
                                            <PracticalGraphic id={item.id} />
                                        </div>

                                    </div>

                                    <div style={{ backgroundColor: 'white', height: '2px', width: '100%' }} />
                                    <div className={styles.infoBit}>
                                        {item.info.map((i) => (

                                            <div style={{ display: 'flex', flexDirection: 'row', width: '100%' }}>
                                                <p >●</p>
                                                <p style={{ paddingLeft: '6px', maxWidth: '90%' }}>{i}</p>
                                            </div>

                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>

                    ))}
                    <div className={styles.eduContainer}>
                        <div className={observe} style={{ width: '90%', display: 'flex', flexDirection: 'row' }}>
                            <div style={{ display: 'flex', paddingRight: '5%', width: '30%', height: '100%' }}>
                                <svg viewBox="0 0 572 361" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M164.164 65.0929V81.8197H15.4342V0H164.164V16.7268H72.6498V33.0567H158.395V48.366H72.6498V65.0929H164.164Z" fill="white" />
                                    <path d="M199.865 0H279.062C341.579 0 374.941 13.9485 374.941 40.0877C374.941 67.5877 342.202 81.8197 279.062 81.8197H199.865V0ZM257.08 16.7268V65.0929H270.332C302.603 65.0929 316.635 57.6083 316.635 40.4846C316.635 24.4382 301.668 16.7268 270.332 16.7268H257.08Z" fill="white" />
                                    <path d="M481.733 65.9434C501.221 65.9434 511.51 60.897 511.51 51.3712V0H568.726V52.5052C568.726 72.0671 536.766 83.464 481.733 83.464C426.7 83.464 394.741 72.0671 394.741 52.5052V0H451.956V51.3712C451.956 60.897 462.246 65.9434 481.733 65.9434Z" fill="white" />
                                    <path d="M91.8256 204.825C109.91 204.825 121.135 199.268 121.135 190.309H179.286C179.286 210.495 147.326 222.232 92.1374 222.232C34.2982 222.232 0 209.758 0 188.722V170.634C0 149.598 34.2982 137.124 92.1374 137.124C147.326 137.124 178.974 148.861 178.974 169.387H120.823C120.823 160.258 109.286 154.531 90.8902 154.531C70.4672 154.531 59.71 160.088 59.71 170.634V188.722C59.71 199.325 70.6231 204.825 91.8256 204.825Z" fill="white" />
                                    <path d="M262.225 187.644H301.356L283.584 157.196H280.621L262.225 187.644ZM320.688 220.588L310.243 202.613H253.183L242.426 220.588H185.678L249.285 138.768H319.285L383.048 220.588H320.688Z" fill="white" />
                                    <path d="M510.263 220.588H453.204V155.495H391.467V138.768H572V155.495H510.263V220.588Z" fill="white" />
                                    <path d="M162.916 359.356H11.069V342.629H58.4628V294.263H11.069V277.536H162.916V294.263H115.522V342.629H162.916V359.356Z" fill="white" />
                                    <path d="M374.006 324.484C374.006 347.335 340.487 361 284.363 361C228.239 361 194.72 347.335 194.72 324.484V312.407C194.72 289.557 228.239 275.892 284.363 275.892C340.487 275.892 374.006 289.557 374.006 312.407V324.484ZM284.363 343.763C306.033 343.763 315.855 337.639 315.855 324.258V312.634C315.855 299.253 306.033 293.129 284.363 293.129C262.693 293.129 252.871 299.253 252.871 312.634V324.258C252.871 337.639 262.693 343.763 284.363 343.763Z" fill="white" />
                                    <path d="M448.371 359.356H399.886V277.536H449.15L512.134 326.412H515.096V277.536H563.581V359.356H514.317L451.333 310.026H448.371V359.356Z" fill="white" />
                                </svg>
                            </div>


                            <div className={styles.praMain2}>
                                <div style={{ display: 'flex', justifyContent: 'center' }}>
                                    <PracticalGraphic id={2} />
                                </div>

                                <p>Bachelor of Applied Science: Computer Engineering (2022-2027)</p>
                            </div>

                        </div>
                    </div>
                </div>


            </header>

        </div>

    );

}

export default Resume;
