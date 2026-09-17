import React from 'react';
import { Link } from 'react-router-dom';
import ProceduralField from './ui/ProceduralField';
import { NAV, SITE_VERSION } from '../data/nav';
import footerField from '../data/footerField';
import socials from './socials.json';
import styles from './footer.module.css';

const LABELS = { linkedin: 'LinkedIn', github: 'GitHub', soundcloud: 'SoundCloud' };

function Footer() {
    const year = new Date().getFullYear();

    return (
        <footer className={styles.footer}>
            <div className={styles.band}>
                <ProceduralField settings={footerField} />
            </div>

            <div className={`wrap grid ${styles.body}`}>
                <div className={styles.cta}>
                    <p className="label bracket">Contact</p>
                    <Link to="/contact" className={styles.big}>
                        Let’s build<br />something<span className={styles.dot}>.</span>
                    </Link>
                </div>

                <div className={styles.col}>
                    <p className="label">Index</p>
                    <ul>
                        {NAV.filter((n) => n.to).map((n) => (
                            <li key={n.label}><Link className="link" to={n.to}>{n.label}</Link></li>
                        ))}
                    </ul>
                </div>

                <div className={styles.col}>
                    <p className="label">Elsewhere</p>
                    <ul>
                        {socials.filter((s) => s.name !== 'cell').map((s) => (
                            <li key={s.id}>
                                <a className="link" href={s.url} target="_blank" rel="noreferrer">
                                    {/* {s.name === 'email' ? s.handle : s.name[0].toUpperCase() + s.name.slice(1)} */}
                                    {LABELS[s.name] || s.name[0].toUpperCase() + s.name.slice(1)}
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className={`${styles.col} ${styles.colophon}`}>
                    <p className="label">Colophon</p>
                    <p>
                        Set in Inter Tight and SF Mono on black paper. Frames and rules are
                        live Perlin noise from the procedural VFX tools.
                    </p>
                </div>
            </div>

            <div className={`wrap ${styles.base}`}>
                <span className="label">© {year} Charles Miguel Henville</span>
                <span className="label">cmhnvl.net — {SITE_VERSION}</span>
                <button
                    type="button"
                    className={`label ${styles.top}`}
                    onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                >
                    Back to top ↑
                </button>
            </div>
        </footer>
    );
}

export default Footer;
