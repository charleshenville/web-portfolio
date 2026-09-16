import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import Logo from './Logo';
import AsciiField from './ui/AsciiField';
import { NAV, SITE_VERSION } from '../data/nav';
import socials from './socials.json';
import styles from './nav.module.css';

const pad = (n) => String(n).padStart(2, '0');

function torontoTime() {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Toronto',
        }).format(new Date());
    } catch (e) {
        return '';
    }
}

function Nav() {
    const { pathname } = useLocation();
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState(() => pathname.startsWith('/vfx'));
    const [scrolled, setScrolled] = useState(false);
    const [time, setTime] = useState(torontoTime);
    const panelRef = useRef(null);
    const buttonRef = useRef(null);
    const isTool = /^\/vfx\/.+/.test(pathname);

    // close on navigation
    useEffect(() => {
        setOpen(false);
        if (pathname.startsWith('/vfx')) setExpanded(true);
    }, [pathname]);

    // solid bar once the page scrolls under the logo
    useEffect(() => {
        const onScroll = () => setScrolled(window.scrollY > 12);
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        const panel = panelRef.current;
        panel.inert = !open;
        document.body.classList.toggle('is-locked', open);
        if (!open) return undefined;

        const first = panel.querySelector('a, button');
        if (first) first.focus({ preventScroll: true });
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setOpen(false);
                if (buttonRef.current) buttonRef.current.focus();
            }
        };
        setTime(torontoTime());
        const clock = setInterval(() => setTime(torontoTime()), 15000);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            clearInterval(clock);
            document.body.classList.remove('is-locked');
        };
    }, [open]);

    const barClass = [
        styles.bar,
        scrolled && !isTool ? styles.barSolid : '',
        open ? styles.barOpen : '',
        isTool ? styles.barTool : '',
    ].join(' ');

    return (
        <>
            <header className={barClass}>
                {!isTool && (
                    <Link to="/" className={styles.logoLink} aria-label="Charles Miguel Henville, home">
                        <Logo />
                    </Link>
                )}
                <button
                    ref={buttonRef}
                    type="button"
                    className={styles.menuBtn}
                    aria-expanded={open}
                    aria-controls="site-menu"
                    onClick={() => setOpen((o) => !o)}
                >
                    <span className={styles.menuWord}>{open ? 'Close' : 'Menu'}</span>
                    <span className={`${styles.burger} ${open ? styles.burgerOpen : ''}`} aria-hidden="true">
                        <span />
                        <span />
                    </span>
                </button>
            </header>

            <div
                className={`${styles.scrim} ${open ? styles.scrimOpen : ''}`}
                onClick={() => setOpen(false)}
                aria-hidden="true"
            />

            <nav
                id="site-menu"
                ref={panelRef}
                className={`${styles.panel} ${open ? styles.panelOpen : ''} paper-grain`}
                aria-label="Site"
            >
                <div className={styles.panelScroll}>
                    <div className={styles.panelHead}>
                        <span className="label bracket">Menu</span>
                        <span className="label">Toronto {time}</span>
                    </div>

                    <div className={styles.panelBand}>
                        <AsciiField animate={open} cell={7} density={-0.08} contrast={1.2} accentAt={0.97} fadeY seed={5} />
                    </div>

                    <ol className={styles.list}>
                        {NAV.map((item, i) => {
                            const n = pad(i + 1);
                            if (item.children) {
                                const inSection = pathname.startsWith(item.to);
                                return (
                                    <li key={item.label} className={styles.item}>
                                        <button
                                            type="button"
                                            className={`${styles.row} ${inSection ? styles.current : ''}`}
                                            aria-expanded={expanded}
                                            aria-controls="menu-vfx"
                                            onClick={() => setExpanded((x) => !x)}
                                        >
                                            <span className={`label ${styles.idx}`}>{n}</span>
                                            <span className={styles.word}>{item.label}</span>
                                            <span className={`${styles.plus} ${expanded ? styles.plusOpen : ''}`} aria-hidden="true" />
                                        </button>
                                        <div
                                            id="menu-vfx"
                                            className={`${styles.sub} ${expanded ? styles.subOpen : ''}`}
                                            inert={expanded ? undefined : ''}
                                        >
                                            <ol className={styles.subList}>
                                                <li>
                                                    <NavLink
                                                        end
                                                        to={item.to}
                                                        className={({ isActive }) => `${styles.subRow} ${isActive ? styles.current : ''}`}
                                                    >
                                                        <span className={`label ${styles.idx}`}>{n}.0</span>
                                                        <span className={styles.subWord}>All tools</span>
                                                    </NavLink>
                                                </li>
                                                {item.children.map((child, k) => (
                                                    <li key={child.to}>
                                                        <NavLink
                                                            to={child.to}
                                                            className={({ isActive }) => `${styles.subRow} ${isActive ? styles.current : ''}`}
                                                        >
                                                            <span className={`label ${styles.idx}`}>{n}.{k + 1}</span>
                                                            <span className={styles.subWord}>{child.label}</span>
                                                        </NavLink>
                                                    </li>
                                                ))}
                                            </ol>
                                        </div>
                                    </li>
                                );
                            }
                            if (item.href) {
                                return (
                                    <li key={item.label} className={styles.item}>
                                        <a className={styles.row} href={item.href} target="_blank" rel="noreferrer">
                                            <span className={`label ${styles.idx}`}>{n}</span>
                                            <span className={styles.word}>{item.label}</span>
                                            <span className={styles.ext} aria-hidden="true">↗</span>
                                        </a>
                                    </li>
                                );
                            }
                            return (
                                <li key={item.label} className={styles.item}>
                                    <NavLink
                                        end={item.to === '/'}
                                        to={item.to}
                                        className={({ isActive }) => `${styles.row} ${isActive ? styles.current : ''}`}
                                    >
                                        <span className={`label ${styles.idx}`}>{n}</span>
                                        <span className={styles.word}>{item.label}</span>
                                    </NavLink>
                                </li>
                            );
                        })}
                    </ol>

                    <div className={styles.panelFoot}>
                        <ul className={styles.socials}>
                            {socials.filter((s) => s.name !== 'cell').map((s) => (
                                <li key={s.id}>
                                    <a className="label link" href={s.url} target={s.name === 'email' ? undefined : '_blank'} rel="noreferrer">
                                        {s.name}
                                    </a>
                                </li>
                            ))}
                        </ul>
                        <span className="label">{SITE_VERSION}</span>
                    </div>
                </div>
            </nav>
        </>
    );
}

export default Nav;
