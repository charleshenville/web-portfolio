import React, { Suspense, lazy, useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import Nav from './components/Nav';
import Footer from './components/Footer';
import Home from './components/pages/Home';
import E404 from './components/pages/E404';
import Loading from './components/ui/Loading';

// Everything except the index is split into its own chunk, so three.js,
// the VFX tools and their encoders only download when they are visited.
const Projects = lazy(() => import('./components/pages/Projects'));
const Music = lazy(() => import('./components/pages/Music'));
const Resume = lazy(() => import('./components/pages/Resume'));
const Contact = lazy(() => import('./components/pages/Contact'));
const VfxIndex = lazy(() => import('./components/pages/VfxIndex'));
const VfxTool = lazy(() => import('./components/pages/VfxTool'));

function ScrollToTop() {
    const { pathname } = useLocation();
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [pathname]);
    return null;
}

// Editorial pages: offset for the fixed header, footer at the end.
function SiteLayout() {
    return (
        <>
            <main id="main" className="page">
                <Suspense fallback={<Loading />}>
                    <Outlet />
                </Suspense>
            </main>
            <Footer />
        </>
    );
}

// Tools own the whole viewport.
function ToolLayout() {
    return (
        <main id="main">
            <Suspense fallback={<Loading fullscreen />}>
                <Outlet />
            </Suspense>
        </main>
    );
}

function App() {
    return (
        <>
            <ScrollToTop />
            <Nav />
            <Routes>
                <Route element={<SiteLayout />}>
                    <Route path="/" element={<Home />} />
                    <Route path="/projects" element={<Projects />} />
                    <Route path="/music" element={<Music />} />
                    <Route path="/vfx" element={<VfxIndex />} />
                    <Route path="/resume" element={<Resume />} />
                    <Route path="/contact" element={<Contact />} />
                    <Route path="*" element={<E404 />} />
                </Route>
                <Route element={<ToolLayout />}>
                    <Route path="/vfx/:slug" element={<VfxTool />} />
                </Route>
                {/* old links */}
                <Route path="/visualizer" element={<Navigate to="/vfx/visualizer" replace />} />
                <Route path="/asciitool" element={<Navigate to="/vfx/ascii" replace />} />
            </Routes>
        </>
    );
}

export default App;
