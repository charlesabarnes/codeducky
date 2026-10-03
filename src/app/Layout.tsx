import { NavLink, Outlet } from 'react-router'

export function Layout() {
  return (
    <div className="app">
      <header className="app-header">
        <NavLink to="/" className="brand">
          <img src="/icon.svg" alt="" width={24} height={24} />
          Skelbert
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Repos
          </NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}
