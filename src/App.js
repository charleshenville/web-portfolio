import './App.css';
import MenuBar from './MenuBar';
import { Routes, Route } from 'react-router-dom';
import Home from './Home';
import Projects from './Projects';
import Resume from './Resume';

function App() {

  return (

    <div className="App">
      <MenuBar />
      <Routes>
        <Route path='/' element={<Home />} />
        <Route path='/projects' element={<Projects />} />
        <Route path='/resume' element={<Resume />} />
      </Routes>
    </div>

  );
}

export default App;
