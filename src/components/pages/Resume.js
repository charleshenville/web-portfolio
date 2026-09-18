import React from 'react';
import PageHeader from '../ui/PageHeader';
import Separator from '../ui/Separator';
import exps from '../expconfig.json';
import languages from '../languages.json';
import styles from './resume.module.css';

const RESUME_PDF = '/CharlesHenville_CV.pdf';
const pad = (n) => String(n).padStart(2, '0');

// "[C, Python]" segments inside a bullet are emphasised.
function Emphasis({ text }) {
    return text.split(/\[(.*?)\]/g).map((part, i) => (
        i % 2 === 1 ? <strong key={i}>{part}</strong> : <React.Fragment key={i}>{part}</React.Fragment>
    ));
}

function splitInfo(info) {
    const [first, ...rest] = info;
    if (first && /^\[.*\]$/.test(first)) {
        return { skills: first.slice(1, -1).split(',').map((s) => s.trim()), bullets: rest };
    }
    return { skills: [], bullets: info };
}

function Resume() {
    return (
        <>
            <PageHeader
                index="05"
                title="Resume"
                meta={['Computer Engineering', 'Minor in AI Engineering', 'Toronto, Canada']}
                aside={(
                    <div className={styles.now}>
                        <p className="label bracket">Currently</p>
                        <ul>
                            {exps.filter((e) => /present/i.test(e.year)).map((e) => (
                                <li key={e.id}>
                                    <span className={styles.nowRole}>{e.role}</span>
                                    <span className={styles.nowOrg}>{e.company}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                lead="Data engineering, embedded systems and the software around them, from datacenter observability and volumetric rendering to autonomous vehicles."
            >
                <a className={styles.download} href={RESUME_PDF} download="CharlesHenville_CV.pdf">
                    <span>Download PDF</span>
                    <span className="label">↓</span>
                </a>
            </PageHeader>

            {/* ---- Experience ---- */}
            <Separator index="05.1" title="Experience" meta={`${exps.length} positions`} />
            <ol className={`wrap ${styles.table}`}>
                {exps.map((e, i) => {
                    const { skills, bullets } = splitInfo(e.info);
                    return (
                        <li key={e.id} className={`grid ${styles.exp}`}>
                            <div className={styles.expWhen}>
                                <span className="label">{pad(i + 1)}</span>
                                <span className="label">{e.year.replace(' - ', ' — ')}</span>
                            </div>
                            <div className={styles.expWho}>
                                <h3 className={styles.expOrg}>{e.company}</h3>
                                <p className={styles.expRole}>{e.role}</p>
                                {skills.length > 0 && (
                                    <ul className={styles.skills}>
                                        {skills.map((s) => <li key={s} className="label">{s}</li>)}
                                    </ul>
                                )}
                            </div>
                            <ul className={styles.expWhat}>
                                {bullets.map((b) => <li key={b}><Emphasis text={b} /></li>)}
                            </ul>
                        </li>
                    );
                })}
            </ol>

            {/* ---- Education ---- */}
            <Separator index="05.2" title="Education" meta="09/22 — 04/27" rows={1} />
            <div className={`wrap ${styles.table}`}>
                <div className={`grid ${styles.exp}`}>
                    <div className={styles.expWhen}>
                        <span className="label">01</span>
                        <span className="label">09/22 — 04/27</span>
                    </div>
                    <div className={styles.expWho}>
                        <h3 className={styles.expOrg}>University of Toronto</h3>
                        <p className={styles.expRole}>Faculty of Applied Science &amp; Engineering</p>
                        <ul className={styles.skills}>
                            <li className="label">CGPA 3.7 / 4.0</li>
                        </ul>
                    </div>
                    <ul className={styles.expWhat}>
                        <li>Bachelor of Applied Science: <strong>Computer Engineering</strong></li>
                        <li>Minor: <strong>Artificial Intelligence Engineering</strong></li>
                        <li>Relevant coursework: <strong>Operating Systems</strong>, <strong>Algorithms &amp; Data Structures</strong>, <strong>Digital Systems</strong>, <strong>Computer Organization</strong>, <strong>Signals &amp; Systems</strong>, <strong>Linear Algebra</strong>, <strong>Software Communication &amp; Design</strong>, <strong>Probability &amp; Applications</strong>, <strong>Calculus I–III</strong></li>
                    </ul>
                </div>
            </div>

            {/* ---- Languages ---- */}
            <Separator index="05.3" title="Languages & Tools" meta="Self-assessed proficiency" rows={1} />
            <div className={`wrap ${styles.table}`} role="table" aria-label="Languages">
                <div className={styles.langHead} role="row">
                    <span className="label" role="columnheader">Lang.</span>
                    <span className="label" role="columnheader">Ext.</span>
                    <span className="label" role="columnheader">Frameworks &amp; tools</span>
                    <span className="label" role="columnheader">Proficiency</span>
                    <span className="label" role="columnheader" />
                </div>
                {[...languages].sort((a, b) => b.proficiency - a.proficiency).map((l) => {
                    // Only the ones with something to show link out.
                    const Row = l.repo ? 'a' : 'div';
                    const link = l.repo ? { href: l.repo, target: '_blank', rel: 'noreferrer' } : {};
                    return (
                        <Row key={l.id} {...link} className={styles.lang} role="row">
                            <span className={styles.langName} role="cell">{l.id}</span>
                            <span className="label" role="cell">.{l.ext}</span>
                            <span className={styles.langSubs} role="cell">{l.subs.join(' / ')}</span>
                            <span className={styles.meter} role="cell" aria-label={`${Math.round(l.proficiency * 100)} percent`}>
                                <span style={{ transform: `scaleX(${l.proficiency})` }} />
                            </span>
                            <span className={`label ${styles.langGo}`} role="cell">{l.repo ? '↗' : ''}</span>
                        </Row>
                    );
                })}
            </div>
        </>
    );
}

export default Resume;
