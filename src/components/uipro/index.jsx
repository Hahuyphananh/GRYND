"use client";

import React from "react";

export const UIPro01NavShell = ({ children, className = "" }) => <div className={className}>{children}</div>;
export const UIPro02NavItem = ({ children, className = "", ...props }) => <a className={className} {...props}>{children}</a>;
export const UIPro03HeroShell = ({ children, className = "" }) => <section className={className}>{children}</section>;
export const UIPro04HeroHeading = ({ children, className = "" }) => <h1 className={className}>{children}</h1>;
export const UIPro05HeroSubtext = ({ children, className = "" }) => <p className={className}>{children}</p>;
export const UIPro06PrimaryButton = ({ children, className = "", ...props }) => <a className={className} {...props}>{children}</a>;
export const UIPro07SecondaryButton = ({ children, className = "", ...props }) => <a className={className} {...props}>{children}</a>;
export const UIPro08SectionShell = ({ children, className = "" }) => <section className={className}>{children}</section>;
export const UIPro09SectionTitle = ({ children, className = "" }) => <h2 className={className}>{children}</h2>;
export const UIPro10CardGrid = ({ children, className = "" }) => <div className={className}>{children}</div>;
export const UIPro11GameCard = ({ children, className = "", ...props }) => <a className={className} {...props}>{children}</a>;
export const UIPro12CardTitle = ({ children, className = "" }) => <h3 className={className}>{children}</h3>;
export const UIPro13CardText = ({ children, className = "" }) => <p className={className}>{children}</p>;
export const UIPro14AccordionShell = ({ children, className = "" }) => <div className={className}>{children}</div>;
export const UIPro15AccordionButton = ({ children, className = "", ...props }) => <button className={className} {...props}>{children}</button>;
export const UIPro16ToastShell = ({ children, className = "" }) => <div className={className}>{children}</div>;
export const UIPro17ModalBackdrop = ({ children, className = "", ...props }) => <div className={className} {...props}>{children}</div>;
export const UIPro18ModalPanel = ({ children, className = "" }) => <div className={className}>{children}</div>;
export const UIPro19Input = ({ className = "", ...props }) => <input className={className} {...props} />;
export const UIPro20Badge = ({ children, className = "" }) => <span className={className}>{children}</span>;
export const UIPro21IconButton = ({ children, className = "", ...props }) => <button className={className} {...props}>{children}</button>;
