import './App.css';
import E404 from './components/E404';
import MenuBar from './components/MenuBar';
import { Routes, Route } from 'react-router-dom';
import Home from './components/Home';
import Projects from './components/Projects';
import Resume from './components/Resume';
import Contact from './components/Contact';
import AsciiTool from './components/AsciiTool';
import AudioVisualizer from './components/AudioVisualizer';

function App() {

  return (

    <div className="App">
      <MenuBar />
      <Routes>
          <Route path='/' element={<Home />} />
          <Route path='/projects' element={<Projects />} />
          <Route path='/resume' element={<Resume />} />
          <Route path='/contact' element={<Contact />} />
          <Route path='/asciitool' element={<AsciiTool/>} />
          <Route path='/visualizer' element={<AudioVisualizer/>} />
          <Route path="*" element={<E404 />} />
      </Routes>
    </div>

  );
}

export default App;
