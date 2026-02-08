export interface Theme {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    error: string;
    warning: string;
    success: string;
    info: string;
  };
}

const defaultTheme: Theme = {
  name: 'default',
  colors: {
    primary: '#007acc',
    secondary: '#6c757d',
    background: '#1e1e1e',
    text: '#d4d4d4',
    error: '#f44336',
    warning: '#ff9800',
    success: '#4caf50',
    info: '#2196f3',
  },
};

class ThemeManager {
  private currentTheme: Theme = defaultTheme;

  getCurrentThemeName(): string {
    return this.currentTheme.name;
  }

  getTheme(): Theme {
    return this.currentTheme;
  }

  setTheme(name: string): void {
    this.currentTheme = { ...defaultTheme, name };
  }
}

export const themeManager = new ThemeManager();
