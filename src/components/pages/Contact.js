import React from 'react';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import socials from '../socials.json';
import styles from './contact.module.css';

const LINK_LABELS = { linkedin: 'LinkedIn', github: 'GitHub', email: 'Email', cell: 'Phone', soundcloud: 'SoundCloud', spotify: 'Spotify' };
const EMAIL = socials.find((s) => s.name === 'email');

function Contact() {
    return (
        <>
            <PageHeader
                index="06"
                title="Contact"
                meta={['Toronto, Canada', 'EST / EDT', 'Email / LinkedIn / GitHub / Music']}
                lead="Let’s get in touch. Collaborations, questions, opportunities or just a hello."
            />

            <Separator index="06.1" title="Reach" meta={`${socials.length} channels`} rows={1} />

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
