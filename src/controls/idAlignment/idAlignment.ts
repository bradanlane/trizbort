import { TextAlign } from '../../drawing/IScreen'
import { OptionsGroup } from "../OptionsGroup";

export class IdAlignment extends OptionsGroup {
  // 
  // Create a new instance of IdShape by providing a query selector that
  // yields an id-shape element.
  //
  constructor(elem: HTMLElement|string, base?: HTMLElement) {
    super(elem,  [
      {value: TextAlign.Left, htmlEl: '.js-align-left'},
      {value: TextAlign.Center, htmlEl: '.js-align-center'},
      {value: TextAlign.Right, htmlEl: '.js-align-right'},
    ], base);
  }

  get dataset(): Object {
    return {
      label: this.elem.dataset.label,
    }
  }

  get template(): string {
    return Handlebars.templates.idAlignment({ label: (<any>this.dataset)['label'] });
  }

/*   set value(shape: RoomShape) {
    this.value = shape;
     this.shape = shape;
    this.selectValue(this.shape);
    let evt = new CustomEvent('change');
    this.elem.dispatchEvent(evt);
  }    

  get value(): RoomShape {
    return this.value;
  }
 */
}