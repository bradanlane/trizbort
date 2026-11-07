# Trizbort.io

[Trizbort.io](https://www.trizbort.io) is a JavaScript implementation of [Trizbort](http://www.trizbort.com), the adventure game mapping and code generation software. It aims to provide all Trizbort features in the browser, so that no download is required to create and share Trizbort maps, and generate code for several adventure design systems.

![Drawing a map in Trizbort.io](https://www.trizbort.io/assets/map.png)

## Code generation

<img align="right" src="https://www.trizbort.io/assets/trizbort-code-generation.png">At the moment, Trizbort.io supports code generation for the following design systems and formats:

* [Alan 2](https://www.alanif.se/)
* [Alan 3](https://www.alanif.se/)
* [Inform 7](http://inform7.com/)
* [Quest](http://textadventures.co.uk/quest)
* [TADS 3](https://www.tads.org/tads3.htm)
* [TextAdventure.js](https://github.com/TheBroox/TextAdventure.js)
* [ZIL](https://archive.org/details/Learning_ZIL_Steven_Eric_Meretzky_1995)
* YAML

Code generation is more complete for some systems than for others. Experts are very welcome to contribute to make code generation results more complete. Code generation for Ink and Hugo may be added in the future.

## Contributing

Trizbort.io is written in TypeScript using the [JAMstack](https://jamstack.org/). There is no server back-end and there are few dependencies. It is simple to get it to run locally so you can hack on it. To do so:

* Install [Node.js](https://nodejs.org/) (a recent version is recommended). It will come with [npm](https://www.npmjs.com/), the Node.js package manager.
* Fork the project to a local directory.
* Run `npm install` to install all dependencies.
* Start the [Vite](https://vitejs.dev/) development server with `npm run dev`. This will start a server on port 3000 with hot module reloading.
* Open `http://localhost:3000` in your browser.
* To create a production build, run `npm run build`. The output will be in the `dist/` directory.

## Public web application

The public end-user implementation of Trizbort runs at [Trizbort.io](https://www.trizbort.io). The implementation is updated regularly to reflect changes as these are built into this repository.


## Fork: bradanlane Branch: background_image

This brand has a series of additions:
I also found a few things ...

1. Support for loading an SVG, PNG, or JPG as a background image to the grid.
    - _The purpose is to simplify building game maps which have a connection to physical spaces. The graphic adheres to zoom and pan operations such that added map elements maintain their position over the underlying graphic._
    - The graphic is supplied as a URL in the map rendering settings UI.
	- The url is persisted in the map JSON thru save and load operations.
	- **Note:** Depending on the server deployment of the Trizbot app, there could be a cross domain limitation. Effort was made to minimize it but it ultimately comes down to server settings.
1. Changed the copy/paste offset.
    - The existing implementation adds the cursor XY to the original XY. This means the new XY can be very far away (even beyond the viewed map).
    - The modified behavior places the copy at the cursor.
1. Made the lower limit for the "dark mark" on a room smaller
1. Added a small square in the lower right corner of a room to provide a visual indicator the room has description text
1. Added the code to support doors on connectors
    - The handlebars file had the markup but it never rendered
    - The necessary JavaScript has been added
    - The UI was moved to the bottom of the Connector panel
1. Implemented pinch-zoom for more intuitive UX. _(needs testing on more browsers and platforms)_
1. UI for an optional max length of connector name text and then text wrap support
1. Text alignment for Notes _(this was a more extensive change than others as it required adding a new control type and leverage the existing `TextAlign` in new locations; however, the implementation now allows for other view types to take advantage of it)_
