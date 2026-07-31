import { DocumentFlow } from './components/DocumentFlow';
import { Inspector } from './components/Inspector';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { useAgentPort } from './hooks/useAgentPort';
import { useTheme } from './hooks/useTheme';

export function App(): React.JSX.Element {
  useTheme();
  useAgentPort();

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <Sidebar />
        <DocumentFlow />
        <Inspector />
      </div>
    </div>
  );
}
