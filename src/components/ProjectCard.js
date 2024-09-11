import styles from './projects.module.css';
import React, { useRef, useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import Spotlight from './Spotlight';
import ProjectMedia from './ProjectMedia';
import Other from './Other';
import Footer from './Footer';

const ProjectCard = ({ items }) => {

    const [hoveredItemId, setHoveredItemId] = useState(null);

    const likeInactiveColor = "grey";
    const likeActiveColor = "#C21F4D";
    const likeSemiColor = "#875563";

    const [likeCounts, setLikeCounts] = useState({});
    const [likedProjects, setLikedProjects] = useState([]);
    const [fingerprint, setFingerprint] = useState('');

    const observe = styles.observe
    const observer = useRef(null);

    const host = "https://samuraimain.ddns.net:8080";

    const fetchLikeCounts = async () => {
        try {
            const response = await fetch(host+'/getGlobLikeStruct');
            const data = await response.json();
            const counts = {};
            data.forEach(item => {
                counts[item.project_id] = item.likes;
            });
            console.log(counts);
            setLikeCounts(counts);
        } catch (error) {
            console.error('Error fetching like counts:', error);
        }
    };

    const fetchLikedProjects = async (fp) => {
        try {
            const response = await fetch(host+`/initPageLoad?fingerprint=${fp}`);
            const data = await response.json();
            setLikedProjects(data);
        } catch (error) {
            console.error('Error fetching liked projects:', error);
        }
    };

    const handleLike = async (id) => {
        if (!likedProjects.includes(id)) {
            try {
                await fetch(host+`/postNewLike?project_id=${id}&fingerprint=${fingerprint}`);
                setLikeCounts(prev => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
                setLikedProjects(prev => [...prev, id]);
            } catch (error) {
                console.error('Error updating like:', error);
            }
        }
    };

    useEffect(() => {

        const storedFingerprint = localStorage.getItem('browserFingerprint');
        if (storedFingerprint) {
            setFingerprint(storedFingerprint);
        } else {
            const newFingerprint = uuidv4();
            localStorage.setItem('browserFingerprint', newFingerprint);
            setFingerprint(newFingerprint);
        }
        // Fetch initial like counts and liked projects
        fetchLikeCounts();
        fetchLikedProjects(storedFingerprint);
    }, []);

    useEffect(() => {
        observer.current = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add(observe);
                    // entry.target.style.filter = 'blur(0)';
                    // entry.target.style.transition = 'filter 1s ease-out';
                    entry.target.style.opacity = '1';
                    entry.target.style.transition = 'opacity 1s ease-out';
                }
                else {
                    entry.target.classList.remove(observe);
                    // entry.target.style.filter = 'blur(5px)';
                    entry.target.style.opacity = '0';
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

    return (

        <div className={styles.mainWidth}>
            <div style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <Spotlight />
            </div>
            {/* <h1 style={{marginTop:'10vh', width: '100%', color: 'white', boxSizing:'border-box'}}>Featured</h1> */}

            <div className={styles.cardSpotWrapper}>
                {items.map((item) => (
                    (!item.isFeatured) ? (null) :
                        (
                            <a style={{ textDecoration: 'none' }} href={item.repo} target="blank" key={item.id}>
                                <div className={styles.cardPadding}>
                                    <div className={styles.cardMain}>
                                        <div className={observe}>
                                            <ProjectMedia isSpot={false} videoUrl={item.vid} thumbnailUrl={item.thumb} />
                                            <div className={styles.cardText}>
                                                <div style={{ minWidth: '50%', paddingLeft: '5%', textAlign: 'left' }}>
                                                    <p>{item.name}</p>
                                                </div>
                                                <div
                                                    style={{ justifyContent: 'flex-end', alignItems: 'center', width: '100%', paddingRight: '5%', textAlign: 'right', position: 'relative', display: 'flex', flexDirection: 'row' }}
                                                >
                                                    <div className={styles.likeButtonCtr}
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            handleLike(item.id);
                                                        }}
                                                        onMouseEnter={() => setHoveredItemId(item.id)}
                                                        onMouseLeave={() => setHoveredItemId(null)}
                                                    >
                                                        <svg className={styles.likeButton} viewBox="0 0 123 107" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                            <path fillRule="evenodd" clipRule="evenodd" d="M59.3898 15.7744C60.1816 16.5524 61.4575 16.5316 62.2204 15.7253C69.5239 8.0062 75.1764 1.53187 86.7912 0.20473C109.961 -2.45527 131.271 21.2647 119.571 44.6147C116.241 51.2647 109.461 59.1747 101.961 66.9347C93.7312 75.4547 84.6212 83.8047 78.2412 90.1347L62.2286 106.019C61.4573 106.784 60.2161 106.793 59.4332 106.04L46.4612 93.5547C29.1612 76.8947 0.951243 55.9247 0.0212432 29.9447C-0.628757 11.7447 13.7312 0.0847305 30.2512 0.294731C44.2606 0.484559 50.5675 7.10658 59.3898 15.7744Z" fill={likedProjects.includes(item.id) ? likeActiveColor : (hoveredItemId === item.id ? likeSemiColor : likeInactiveColor)} />
                                                        </svg>
                                                        <p style={{ 'color': likedProjects.includes(item.id) ? likeActiveColor : (hoveredItemId === item.id ? likeSemiColor : likeInactiveColor) }}>
                                                            {likeCounts[item.id] || 0}
                                                        </p>
                                                    </div>
                                                    <p>{item.date}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </a>
                        )
                ))}
            </div>

            <div style={{ width: '100%', display: 'flex', justifyContent: 'center', alignContent: 'center' }}>
                <Other />
            </div>

            <div className={styles.cardWrapper}>
                {items.map((item) => (
                    (item.isFeatured) ? (null) :
                        (
                            <a style={{ textDecoration: 'none' }} href={item.repo} target="blank" key={item.id}>
                                <div className={styles.cardPadding}>
                                    <div className={styles.cardMain}>
                                        <div className={observe}>
                                            <ProjectMedia isSpot={false} videoUrl={item.vid} thumbnailUrl={item.thumb} />
                                            <div className={styles.cardText}>
                                                <div style={{ minWidth: '50%', paddingLeft: '5%', textAlign: 'left' }}>
                                                    <p>{item.name}</p>
                                                </div>
                                                <div
                                                    style={{ justifyContent: 'flex-end', alignItems: 'center', width: '100%', paddingRight: '5%', textAlign: 'right', position: 'relative', display: 'flex', flexDirection: 'row' }}
                                                >
                                                    <div className={styles.likeButtonCtr}
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            handleLike(item.id);
                                                        }}
                                                        onMouseEnter={() => setHoveredItemId(item.id)}
                                                        onMouseLeave={() => setHoveredItemId(null)}
                                                    >
                                                        <svg className={styles.likeButton} viewBox="0 0 123 107" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                            <path fillRule="evenodd" clipRule="evenodd" d="M59.3898 15.7744C60.1816 16.5524 61.4575 16.5316 62.2204 15.7253C69.5239 8.0062 75.1764 1.53187 86.7912 0.20473C109.961 -2.45527 131.271 21.2647 119.571 44.6147C116.241 51.2647 109.461 59.1747 101.961 66.9347C93.7312 75.4547 84.6212 83.8047 78.2412 90.1347L62.2286 106.019C61.4573 106.784 60.2161 106.793 59.4332 106.04L46.4612 93.5547C29.1612 76.8947 0.951243 55.9247 0.0212432 29.9447C-0.628757 11.7447 13.7312 0.0847305 30.2512 0.294731C44.2606 0.484559 50.5675 7.10658 59.3898 15.7744Z" fill={likedProjects.includes(item.id) ? likeActiveColor : (hoveredItemId === item.id ? likeSemiColor : likeInactiveColor)} />
                                                        </svg>
                                                        <p style={{ 'color': likedProjects.includes(item.id) ? likeActiveColor : (hoveredItemId === item.id ? likeSemiColor : likeInactiveColor) }}>
                                                            {likeCounts[item.id] || 0}
                                                        </p>
                                                    </div>
                                                    <p>{item.date}</p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </a>
                        )
                ))}
            </div>

            <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }} className={observe}>
                <Footer />
            </div>

        </div>

    );
};

export default ProjectCard;