// Augment React's JSX to include the `jsx` prop on <style>, which
// styled-jsx adds at compile time but is not in the standard React types.
import 'react';

declare module 'react' {
  interface StyleHTMLAttributes<T> extends React.HTMLAttributes<T> {
    jsx?: boolean;
  }
}

export {};
