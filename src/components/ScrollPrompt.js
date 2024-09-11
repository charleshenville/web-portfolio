import React, { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

const ScrollPrompt = () => {

    const [opacityF, setOpacityF] = useState(1);

    useEffect(() => {
        const handleScroll = () => {
            const scrollPosition = window.scrollY;
            const windowHeight = window.innerHeight;
            setOpacityF(Math.max(0,(1 - 2 * scrollPosition / windowHeight)));
        };

        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const containerStyle = {
        position: 'fixed',
        bottom: '32px',
        left: '50%',
        zIndex: 1000,
        transform: 'translateX(-50%)',
        animation: 'bounce 2s ease-in-out infinite',
        opacity: opacityF
    };

    const iconContainerStyle = {
        backgroundColor: 'white',
        width: '20px',
        height: '20px',
        borderRadius: '50%',
        padding: '8px'
    };

    if (opacityF === 0) return null;

    return (
        <div style={containerStyle}>
            <div style={iconContainerStyle}>
                <ChevronDown color="black" size={20} />
            </div>
            <style>
                {`
                    @keyframes bounce {
                        0%, 100% {
                        transform: translateY(0) translateX(-50%);
                        }
                        50% {
                        transform: translateY(-10px) translateX(-50%);
                        }
                    }
                `}
            </style>
        </div>
    );
};

export default ScrollPrompt;