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
          <Route path='/' exact element={<Home />} />
          <Route path='/projects' exact element={<Projects />} />
          <Route path='/resume' exact element={<Resume />} />
          <Route path='/contact' exact element={<Contact />} />
      </Routes>
    </div>

  );
}

export default App;
