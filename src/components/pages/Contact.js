import React, { useRef, useState } from 'react';
import emailjs from '@emailjs/browser';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import Frame from '../ui/Frame';
import PointCloud from '../ui/PointCloud';
import socials from '../socials.json';
import styles from './contact.module.css';

const LINK_LABELS = { linkedin: 'LinkedIn', github: 'GitHub', email: 'Email', cell: 'Phone' };

function Contact() {
    const formRef = useRef(null);
    const [status, setStatus] = useState({ text: 'All fields are required.', tone: 'idle' });
    const [sending, setSending] = useState(false);
    const [loadPct, setLoadPct] = useState(0);

    const sendEmail = (e) => {
        e.preventDefault();
        const form = formRef.current;
        const values = ['firstname', 'lastname', 'email', 'usermessage'].map((k) => form[k].value.trim());
        if (values.some((v) => v === '')) {
            setStatus({ text: 'Please fill in all form fields.', tone: 'error' });
            return;
        }
        if (!values[2].includes('@') || !values[2].includes('.')) {
            setStatus({ text: 'Please enter a valid email address.', tone: 'error' });
            return;
        }

        setSending(true);
        setStatus({ text: 'Sending…', tone: 'idle' });
        emailjs
            .sendForm('service_khx2ntp', 'template_adla74a', form, 'K2gA7Qym2vSMS9Ifv')
            .then(
                () => {
                    setStatus({ text: 'Message sent. Thank you!', tone: 'ok' });
                    form.reset();
                    setTimeout(() => setSending(false), 10000);
                },
                () => {
                    setStatus({ text: 'Something went wrong. Try again later!', tone: 'error' });
                    setTimeout(() => setSending(false), 30000);
                },
            );
    };

    return (
        <>
            <PageHeader
                index="06"
                title="Contact"
                meta={['Toronto, Canada', 'EST / EDT', 'Email / LinkedIn / GitHub']}
                lead="Let’s get in touch. Collaborations, questions, opportunities or just a hello."
            />

            <Separator index="06.1" title="Write" meta="Via EmailJS" rows={2} />

            <section className={`wrap grid ${styles.layout}`}>
                <form ref={formRef} className={styles.form} onSubmit={sendEmail} noValidate>
                    <label className={styles.field}>
                        <span className="label">01 — First name</span>
                        <input name="firstname" type="text" maxLength={30} autoComplete="given-name" />
                    </label>
                    <label className={styles.field}>
                        <span className="label">02 — Last name</span>
                        <input name="lastname" type="text" maxLength={30} autoComplete="family-name" />
                    </label>
                    <label className={`${styles.field} ${styles.wide}`}>
                        <span className="label">03 — Email</span>
                        <input name="email" type="email" maxLength={60} autoComplete="email" />
                    </label>
                    <label className={`${styles.field} ${styles.wide}`}>
                        <span className="label">04 — Message</span>
                        <textarea name="usermessage" maxLength={300} rows={5} />
                    </label>
                    <div className={`${styles.wide} ${styles.submitRow}`}>
                        <p className={`label ${styles[status.tone]}`} role="status" aria-live="polite">{status.text}</p>
                        <button type="submit" className={styles.submit} disabled={sending}>
                            <span>Send message</span>
                            <span aria-hidden="true">→</span>
                        </button>
                    </div>
                </form>

                <aside className={styles.aside}>
                    <Frame
                        caption={<><span>Fig. 01 — point_cloud.ply</span><span>{loadPct < 1 ? `${Math.round(loadPct * 100)}%` : '120,554 pts'}</span></>}
                    >
                        <div className={styles.cloudStage}>
                            <PointCloud url="assets/point_cloud_lite.ply" onProgress={setLoadPct} />
                        </div>
                    </Frame>

                    <ul className={styles.links}>
                        {socials.map((s) => (
                            <li key={s.id}>
                                <a href={s.url} target={s.url.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className={styles.linkRow}>
                                    <span className="label">{LINK_LABELS[s.name] || s.name}</span>
                                    <span className={styles.handle}>{s.name === 'cell' ? 'Call' : s.handle}</span>
                                    <span aria-hidden="true">↗</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </aside>
            </section>
        </>
    );
}

export default Contact;
