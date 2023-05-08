import React, { useState } from 'react';

const ProjectMedia = ({ videoUrl, thumbnailUrl }) => {
  const [isHovering, setIsHovering] = useState(false);

  const handleMouseEnter = () => {
    setIsHovering(true);
  };

  const handleMouseLeave = () => {
    setIsHovering(false);
  };

  return (
    <div onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {isHovering ? (
        <video src={videoUrl} autoPlay muted loop />
      ) : (
        <img src={thumbnailUrl} alt="Thumbnail" />
      )}
    </div>
  );
};

export default ProjectMedia;
