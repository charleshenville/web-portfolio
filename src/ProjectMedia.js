import React, { useState, useRef } from 'react';
import styles from './projects.module.css'

const ProjectMedia = ({ isSpot, videoUrl, thumbnailUrl }) => {
    const [isHovering, setIsHovering] = useState(false);
    const videoRef = useRef(null);

    const handleMouseEnter = () => {
        setIsHovering(true);
        videoRef.current.play();
    };

    const handleMouseLeave = () => {
        setIsHovering(false);
        videoRef.current.pause();
        //videoRef.current.currentTime = 0;
    };

    const vidStyle = {
        position: 'absolute',
        height: '100%',
        width: '100%',
        objectFit: 'cover',
        opacity: isHovering ? 1 : 0,
        transition: 'opacity 0.3s ease-in-out',
        zIndex: 2,
        borderRadius: isSpot ? ('10px 10px 10px 10px') : ('10px 10px 0px 0px'),
        top: '0',
        left: '0'
    };

    return (
        <div className={styles.mediaContainer} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
            <video style={vidStyle} src={videoUrl} muted loop ref={videoRef} />
            <img style={{borderRadius : isSpot ? ('10px 10px 10px 10px') : ('10px 10px 0px 0px')}} className={styles.media} src={thumbnailUrl} alt="Thumbnail" />
        </div>
    );
};

export default ProjectMedia;
