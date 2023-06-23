import './App.css';
import MenuBar from './components/MenuBar';
import { Routes, Route } from 'react-router-dom';
import Home from './components/Home';
import Projects from './components/Projects';
import Resume from './components/Resume';
import Contact from './components/Contact';

function App() {

  return (

    <div className="App">
      <MenuBar />
      <Routes>
          <Route exact path='/' element={<Home />} />
          <Route exact path='/projects' element={<Projects />} />
          <Route exact path='/resume' element={<Resume />} />
          <Route exact path='/contact' element={<Contact />} />
          <Route path="*" element={<Projects />} />
      </Routes>
    </div>

  );
}

export default App;
