// Adds the `jsx` prop on <style>, which styled-jsx injects at compile time but standard React types lack.
import 'react';

declare module 'react' {
  interface StyleHTMLAttributes<T> extends React.HTMLAttributes<T> {
    jsx?: boolean;
  }
}

export {};
