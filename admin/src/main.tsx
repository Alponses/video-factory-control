import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { adminRoutes } from './routes';
import './styles.css';
import './phase5.css';

const router = createBrowserRouter(adminRoutes);
const root = document.getElementById('root');
if (!root) throw new Error('Admin root element is missing');
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
