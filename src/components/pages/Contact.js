import React from 'react';
import ProceduralField from '../ui/ProceduralField';
import socials from '../socials.json';
import contactField from '../../data/contactField';
import styles from './contact.module.css';

const LINK_LABELS = { linkedin: 'LinkedIn', github: 'GitHub', email: 'Email', cell: 'Phone', soundcloud: 'SoundCloud', spotify: 'Spotify' };
const EMAIL = socials.find((s) => s.name === 'email');

function Contact() {
    return (
        <>
            {/* ---- Masthead: the page opener over a live fluid field ---- */}
            <header className={styles.hero}>
                <div className={styles.heroField}>
                    <ProceduralField settings={contactField} fps={24} viewAspect={0.7} />
                </div>
                <div className={styles.heroScrim} aria-hidden="true" />

                <div className={`wrap ${styles.heroInner}`}>
                    <div className={`grid ${styles.heroMeta}`}>
                        <span className={`label bracket ${styles.heroIndex}`}>06</span>
                        <span className={`label ${styles.heroItem}`}>Toronto, Canada</span>
                        <span className={`label ${styles.heroItem}`}>EST / EDT</span>
                        <span className={`label ${styles.heroItem}`}>{socials.length} channels</span>
                    </div>
                    <h1 className={styles.heroTitle}>
                        Contact<span className={styles.stop}>.</span>
                    </h1>
                    <p className={styles.heroLead}>
                        Let’s get in touch. Collaborations, questions, opportunities or just a hello.
                    </p>
                </div>
            </header>

            <section className={`wrap ${styles.layout}`}>
                {EMAIL && (
                    <a href={EMAIL.url} className={styles.email}>
                        <span className="label bracket">Email</span>
                        <span className={styles.address}>{EMAIL.handle}</span>
                    </a>
                )}

                <ul className={styles.links}>
                    {socials.map((s) => (
                        <li key={s.id}>
                            <a href={s.url} target={s.url.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className={styles.linkRow}>
                                <span className="label">{LINK_LABELS[s.name] || s.name}</span>
                                <span className={styles.handle}>{s.handle}</span>
                                <span aria-hidden="true">↗</span>
                            </a>
                        </li>
                    ))}
                </ul>
            </section>
        </>
    );
}

export default Contact;
